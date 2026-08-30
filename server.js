/**
 * CodeSnapper — server.js
 *
 * 1. Serves static frontend files
 * 2. POST /api/extract          — Gemini Vision proxy (server-side API key)
 * 3. POST /api/auth/register    — Create account (bcrypt + JWT)
 * 4. POST /api/auth/login       — Sign in
 * 5. GET  /api/auth/me          — Get current user info + remaining count
 *
 * Limits:
 *   Anonymous : 25 total  (tracked in browser localStorage, no server tracking)
 *   Signed-in : 50 per rolling 24-hour window (tracked server-side)
 *
 * Credential priority (highest → lowest):
 *   1. GOOGLE_SERVICE_ACCOUNT_JSON  — service account JSON (recommended for production)
 *   2. GEMINI_API_KEY starting with AIza — permanent API key from Google Cloud Console
 *   3. GEMINI_API_KEY starting with AQ.  — short-lived OAuth2 bearer (local dev only)
 *
 * Setup:
 *   See README or run `node server.js --help` for credential setup instructions.
 */

'use strict';

const path    = require('path');
const fs      = require('fs');
const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
require('dotenv').config();

/* ─── google-auth-library (optional — only used for service account auth) ── */
let GoogleAuth = null;
try {
  ({ GoogleAuth } = require('google-auth-library'));
} catch {
  // package not installed — service account auth will be unavailable
}


const app  = express();
const PORT = process.env.PORT || 3000;

/* ─── Auth config ────────────────────────────────────────────────────────── */
const JWT_SECRET  = process.env.JWT_SECRET || 'cs-secret-change-me';
const JWT_EXPIRY  = '30d';
const USERS_FILE  = path.join(__dirname, 'users.json');
const AUTH_LIMIT  = 50;                    // extractions per rolling window
const WINDOW_MS   = 24 * 60 * 60 * 1000;  // 24-hour rolling window
/* ─── Gemini config ──────────────────────────────────────────────────────── */
const GEMINI_NATIVE_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_OPENAI_URL  = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

// Verified ultra-low-latency models in order of response speed
const GEMINI_MODELS = [
  'gemini-3.5-flash-lite', // ~688ms
  'gemini-3.5-flash',      // ~1133ms
  'gemini-3.6-flash',      // ~2004ms
];

const PER_MODEL_TIMEOUT_MS       = 5000;  // 5 seconds max per model attempt
const MAX_IMAGE_TOTAL_TIMEOUT_MS = 20000; // 20 seconds max per image across ALL models combined

const EXTRACTION_PROMPT = `You are CodeSnapper — a precision code extraction engine. Your ONLY task is to transcribe the source code visible in this image.

IMPORTANT: The image may be rotated, taken at an angle, in portrait or landscape orientation, or photographed from a screen. Mentally correct for any rotation or perspective and extract the code as if the image were perfectly straight.

STRICT RULES — FOLLOW EXACTLY:
1. Output ONLY the raw source code — absolutely nothing else before the code starts
2. Do NOT wrap in markdown code fences (no \`\`\` blocks)
3. Do NOT add any explanations, labels, comments, or descriptions
4. Preserve EXACT indentation — spaces and tabs exactly as shown
5. Preserve ALL special characters exactly: : ; , . ( ) [ ] { } < > / \\ | + - * = ! @ # $ % ^ & ~ ? ' " \` newlines etc.
6. Preserve EXACT line breaks — every line of code on its own line
7. Do NOT modify, fix, or "improve" the code — transcribe it EXACTLY as displayed
8. After the code, if you are uncertain about ANY characters, add a blank line then:
   # AMBIGUOUS: line [N]: '[char]' could be '[alternative]'
9. If the image does NOT contain source code or programming language code (for example: photos, artwork, logos, people, or document text without source code), output EXACTLY: # NO_CODE_FOUND

Transcribe the code now:`;

/* ─── Credential resolver & Automatic Token Refresh (45-Minute Window) ────── */
const GEMINI_SCOPES = [
  'https://www.googleapis.com/auth/generative-language',
  'https://www.googleapis.com/auth/cloud-platform',
];

const TOKEN_REFRESH_INTERVAL_MS = 45 * 60 * 1000; // 45 minutes

let _cachedToken = (process.env.GEMINI_API_KEY || '').trim();
let _tokenLoadedAt = Date.now();
let _authClient = null;
let _isServiceAccountActive = false;
let _serviceAccountEmail = null;
let _lastAuthError = null;
let _lastSuccessfulApiCall = null;
let _totalSuccessfulCalls = 0;

/**
 * Searches environment variables for service account credentials across all common keys.
 */
function findServiceAccountRaw() {
  const candidateKeys = [
    'GOOGLE_SERVICE_ACCOUNT_JSON',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GCP_SERVICE_ACCOUNT',
    'SERVICE_ACCOUNT_JSON',
    'GCP_KEY',
    'GCP_SA_KEY',
  ];
  for (const key of candidateKeys) {
    const val = process.env[key];
    if (val && typeof val === 'string' && val.trim()) {
      return { key, value: val.trim() };
    }
  }
  return null;
}

/**
 * Robustly parses service account credentials from raw strings, file paths, base64, or quoted strings.
 */
function parseServiceAccountJson(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return null;
  let str = rawInput.trim();

  // 1. If pointing to a file path that exists on disk (e.g. Render Secret Files)
  if (fs.existsSync(str)) {
    try {
      str = fs.readFileSync(str, 'utf8').trim();
    } catch (err) {
      throw new Error(`Failed to read credential file at "${rawInput}": ${err.message}`);
    }
  }

  // 2. Strip wrapping single or double quotes if present
  if ((str.startsWith("'") && str.endsWith("'")) || (str.startsWith('"') && str.endsWith('"'))) {
    str = str.slice(1, -1).trim();
  }

  // 3. If base64 encoded (common on Render to avoid multi-line issues)
  if (!str.startsWith('{')) {
    try {
      const decoded = Buffer.from(str, 'base64').toString('utf8').trim();
      if (decoded.startsWith('{')) {
        str = decoded;
      }
    } catch (_) {}
  }

  // 4. Parse JSON
  let creds;
  try {
    creds = JSON.parse(str);
  } catch (err) {
    try {
      const unescaped = str.replace(/\\"/g, '"');
      creds = JSON.parse(unescaped);
    } catch (err2) {
      throw new Error(`Invalid JSON syntax in service account credential: ${err.message}`);
    }
  }

  // 5. Validate essential fields
  if (!creds.client_email || !creds.private_key) {
    throw new Error(`Service account JSON missing required fields (client_email: ${!!creds.client_email}, private_key: ${!!creds.private_key})`);
  }

  // 6. Normalize private key newlines
  if (typeof creds.private_key === 'string' && creds.private_key.includes('\\n')) {
    creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  }

  return creds;
}

/**
 * Checks token age and mints fresh token using GoogleAuth service account or GEMINI_API_KEY.
 */
async function refreshTokenIfNeeded(force = false) {
  const ageMs = Date.now() - _tokenLoadedAt;
  if (!force && _cachedToken && ageMs < TOKEN_REFRESH_INTERVAL_MS && _isServiceAccountActive) {
    return _cachedToken;
  }

  const nowIso = new Date().toISOString();
  const rawCred = findServiceAccountRaw();

  // 1. Try GoogleAuth via service account credentials
  if (GoogleAuth && rawCred) {
    try {
      const credentials = parseServiceAccountJson(rawCred.value);
      _serviceAccountEmail = credentials.client_email;

      if (!_authClient || force) {
        const auth = new GoogleAuth({ credentials, scopes: GEMINI_SCOPES });
        _authClient = await auth.getClient();
      }

      const tokenObj = await _authClient.getAccessToken();
      if (tokenObj && tokenObj.token) {
        _cachedToken = tokenObj.token;
        _tokenLoadedAt = Date.now();
        _isServiceAccountActive = true;
        _lastAuthError = null;
        const prefix = _cachedToken.slice(0, 10);
        console.log(`[Auth] [${nowIso}] ✓ Token refreshed via GoogleAuth service account (${prefix}…) [${credentials.client_email}]`);
        return _cachedToken;
      } else {
        throw new Error('GoogleAuth getAccessToken() returned empty token');
      }
    } catch (err) {
      _lastAuthError = err.message;
      console.error(`[Auth] [${nowIso}] ✗ Service account auth failed (${rawCred.key}):`, err.message);
      if (err.stack) console.error(err.stack);
    }
  }

  // 2. Fallback to static GEMINI_API_KEY
  const staticKey = (process.env.GEMINI_API_KEY || '').trim();
  if (staticKey && staticKey !== 'your_gemini_api_key_here') {
    _cachedToken = staticKey;
    _tokenLoadedAt = Date.now();
    _isServiceAccountActive = false;
    const prefix = staticKey.slice(0, 10);
    console.warn(`[Auth] [${nowIso}] ⚠ Using static API key (${prefix}…). Service account is NOT active — this key will expire hourly if starting with AQ.!`);
    return _cachedToken;
  }

  throw new Error('No valid Gemini credentials found. Please set GOOGLE_SERVICE_ACCOUNT_JSON or GEMINI_API_KEY.');
}

/**
 * Returns the credential to use for this request.
 * Automatically checks token age (< 45 min) and refreshes when needed.
 * @returns {{ token: string, mode: string, isBearer: boolean, format: string }}
 */
async function getGeminiToken() {
  await refreshTokenIfNeeded(false);

  if (!_cachedToken || _cachedToken === 'your_gemini_api_key_here') {
    const err = new Error('No Gemini API key or credentials configured.');
    err.code = 'SERVER_CONFIG_ERROR';
    throw err;
  }

  const staticKey = (process.env.GEMINI_API_KEY || '').trim();
  let tokenToUse = _cachedToken;
  let isBearer = _cachedToken.startsWith('ya29.');

  // Google Generative Language Developer API restricts service account OAuth tokens (ya29.)
  // When an Authorization Key (AQ.) or API key (AIza) is available, use it directly via ?key= for 0ms overhead
  if (isBearer && staticKey && staticKey !== 'your_gemini_api_key_here') {
    tokenToUse = staticKey;
    isBearer = false;
  }

  const format = tokenToUse.startsWith('AQ.') ? 'AQ.'
               : tokenToUse.startsWith('AIza') ? 'AIza'
               : tokenToUse.startsWith('ya29.') ? 'OAuth (ya29)'
               : 'Standard';

  return {
    token: tokenToUse,
    mode: _isServiceAccountActive ? 'service-account' : 'api-key',
    isBearer,
    format,
  };
}

/* ─── Middleware ─────────────────────────────────────────────────────────── */
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname)));

/* ─── SQLite Database Initialization ─────────────────────────────────────── */
const Database = require('better-sqlite3');

function resolveDatabasePath() {
  const candidateDirs = [
    process.env.DATA_DIR,
    process.env.RENDER_DISK_PATH,
    process.env.PERSISTENT_DIR,
    '/var/data',
    '/data',
  ].filter(Boolean);

  for (const dir of candidateDirs) {
    try {
      if (fs.existsSync(dir)) {
        fs.accessSync(dir, fs.constants.W_OK);
        const persistentPath = path.join(dir, 'codesnapper.db');
        console.log(`[Database] ✓ Using persistent disk storage at: ${persistentPath}`);
        return persistentPath;
      }
    } catch (e) {
      console.warn(`[Database] Candidate directory "${dir}" not writable:`, e.message);
    }
  }

  const localPath = path.join(__dirname, 'codesnapper.db');
  if (process.env.RENDER === 'true') {
    console.warn('\n[Database] ⚠️  RENDER ENVIRONMENT DETECTED WITHOUT PERSISTENT DISK!');
    console.warn('[Database] Render ephemeral filesystem resets on redeployment.');
    console.warn('[Database] To persist registered user accounts across redeploys, attach a Render Disk at mount path: /var/data\n');
  } else {
    console.log(`[Database] Using database file: ${localPath}`);
  }
  return localPath;
}

const DB_FILE  = resolveDatabasePath();
const db       = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

// Table schema
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    window_start INTEGER NOT NULL,
    count_in_window INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS anon_usage (
    ip TEXT PRIMARY KEY,
    count INTEGER DEFAULT 0,
    last_used_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    description TEXT,
    timestamp TEXT NOT NULL,
    user_email TEXT,
    page TEXT
  );
  CREATE TABLE IF NOT EXISTS ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stars INTEGER NOT NULL,
    feedback TEXT,
    user_email TEXT NOT NULL DEFAULT 'anonymous',
    timestamp TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

// Dynamic column migrations for users table (total_extractions, has_rated)
const userCols = db.prepare(`PRAGMA table_info(users)`).all().map(c => c.name);
if (!userCols.includes('total_extractions')) {
  db.exec(`ALTER TABLE users ADD COLUMN total_extractions INTEGER DEFAULT 0;`);
}
if (!userCols.includes('has_rated')) {
  db.exec(`ALTER TABLE users ADD COLUMN has_rated INTEGER DEFAULT 0;`);
}

// Dynamic schema migration for extraction_history (90-day retention schema)
const historyTableInfo = db.prepare(`PRAGMA table_info(extraction_history)`).all();
if (historyTableInfo.length > 0) {
  const colNames = historyTableInfo.map(c => c.name);
  if (!colNames.includes('custom_name') || !colNames.includes('extracted_code') || !colNames.includes('expires_at')) {
    console.log('[Database] Upgrading extraction_history table to 90-day retention schema...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS extraction_history_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT NOT NULL,
        custom_name TEXT NOT NULL,
        extracted_code TEXT NOT NULL,
        language TEXT NOT NULL DEFAULT 'auto',
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
    try {
      const oldRows = db.prepare(`SELECT * FROM extraction_history`).all();
      const insertStmt = db.prepare(`
        INSERT INTO extraction_history_v2 (id, user_email, custom_name, extracted_code, language, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const r of oldRows) {
        const code = r.extracted_code || r.code_text || '';
        const lang = r.language || r.lang || 'auto';
        const createdAt = r.created_at || Date.now();
        const expiresAt = r.expires_at || (createdAt + 90 * 24 * 60 * 60 * 1000);
        const customName = r.custom_name || `Extraction · ${new Date(createdAt).toLocaleDateString()}`;
        insertStmt.run(r.id, r.user_email, customName, code, lang, createdAt, expiresAt);
      }
    } catch (e) {
      console.warn('[Database] History migration note:', e.message);
    }
    db.exec(`
      DROP TABLE extraction_history;
      ALTER TABLE extraction_history_v2 RENAME TO extraction_history;
    `);
    console.log('[Database] ✓ extraction_history table upgraded successfully');
  }
} else {
  db.exec(`
    CREATE TABLE IF NOT EXISTS extraction_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_email TEXT NOT NULL,
      custom_name TEXT NOT NULL,
      extracted_code TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'auto',
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
}
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_history_user_created ON extraction_history(user_email, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_history_expires_at ON extraction_history(expires_at);
`);

// Auto-migrate legacy users.json if present
if (fs.existsSync(USERS_FILE)) {
  try {
    const rawUsers = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    const insertStmt = db.prepare(`
      INSERT INTO users (email, password_hash, created_at, window_start, count_in_window)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET
        password_hash = excluded.password_hash,
        created_at = excluded.created_at,
        window_start = excluded.window_start,
        count_in_window = excluded.count_in_window
    `);
    const migrateTx = db.transaction((usersMap) => {
      let count = 0;
      for (const [email, u] of Object.entries(usersMap)) {
        insertStmt.run(email, u.passwordHash, u.createdAt || Date.now(), u.windowStart || Date.now(), u.countInWindow || 0);
        count++;
      }
      return count;
    });
    const migrated = migrateTx(rawUsers);
    console.log(`[Database] ✓ Migrated ${migrated} user account(s) from users.json to SQLite database`);
    fs.unlinkSync(USERS_FILE);
  } catch (e) {
    console.error('[Database] ⚠ Legacy users.json migration note:', e.message);
  }
}

/* ─── IP & Usage Helpers ─────────────────────────────────────────────────── */
const ANON_LIMIT = 25;

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || req.ip || '127.0.0.1';
}

function getAnonUsage(ip) {
  const row = db.prepare('SELECT count FROM anon_usage WHERE ip = ?').get(ip);
  const count = row ? row.count : 0;
  return { ip, count, remaining: Math.max(0, ANON_LIMIT - count), limit: ANON_LIMIT };
}

function incAnonUsage(ip) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO anon_usage (ip, count, last_used_at)
    VALUES (?, 1, ?)
    ON CONFLICT(ip) DO UPDATE SET count = count + 1, last_used_at = ?
  `).run(ip, now, now);
  return getAnonUsage(ip);
}

function getUser(email) {
  if (!email || typeof email !== 'string') return null;
  const clean = email.toLowerCase().trim();
  const row = db.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)').get(clean);
  if (!row) return null;
  return {
    email: row.email.toLowerCase().trim(),
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    windowStart: row.window_start,
    countInWindow: row.count_in_window,
  };
}

function saveUser(user) {
  const cleanEmail = (user.email || '').toLowerCase().trim();
  db.prepare(`
    INSERT INTO users (email, password_hash, created_at, window_start, count_in_window)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      password_hash = excluded.password_hash,
      created_at = excluded.created_at,
      window_start = excluded.window_start,
      count_in_window = excluded.count_in_window
  `).run(cleanEmail, user.passwordHash, user.createdAt, user.windowStart, user.countInWindow);
}

function refreshWindow(user) {
  const now = Date.now();
  if (!user.windowStart || now - user.windowStart > WINDOW_MS) {
    user.windowStart   = now;
    user.countInWindow = 0;
    saveUser(user);
  }
}

function getRemaining(user) {
  refreshWindow(user);
  return Math.max(0, AUTH_LIMIT - (user.countInWindow || 0));
}

/* ─── Extraction History Helpers (90-day retention, max 100 per user) ──────── */
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_HISTORY_PER_USER = 100;

function generateDefaultHistoryName(lang, timestamp) {
  const d = new Date(timestamp || Date.now());
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = monthNames[d.getMonth()];
  const day = d.getDate();
  const langDisplay = (lang && lang !== 'auto' && lang !== 'plaintext')
    ? lang.charAt(0).toUpperCase() + lang.slice(1)
    : 'Code';
  return `${langDisplay} · ${month} ${day}`;
}

function cleanupExpiredHistory() {
  const now = Date.now();
  const res = db.prepare('DELETE FROM extraction_history WHERE expires_at <= ?').run(now);
  const count = res.changes || 0;
  if (count > 0) {
    console.log(`[History Cleanup] Deleted ${count} expired extraction history row(s) (90-day retention)`);
  }
  return count;
}

// Run cleanup immediately on server start and once daily (every 24h)
cleanupExpiredHistory();
setInterval(cleanupExpiredHistory, 24 * 60 * 60 * 1000);

function saveExtractionHistory(email, extractedCode, language = 'auto', customName = null) {
  if (!email || !extractedCode || typeof extractedCode !== 'string') return null;
  const emailClean = email.toLowerCase().trim();
  const now = Date.now();
  const expiresAt = now + NINETY_DAYS_MS;
  const name = (customName && customName.trim()) ? customName.trim() : generateDefaultHistoryName(language, now);

  const info = db.prepare(`
    INSERT INTO extraction_history (user_email, custom_name, extracted_code, language, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(emailClean, name, extractedCode, language || 'auto', now, expiresAt);

  // FIFO: Enforce 100-entry limit per user
  db.prepare(`
    DELETE FROM extraction_history
    WHERE LOWER(user_email) = LOWER(?) AND id NOT IN (
      SELECT id FROM extraction_history
      WHERE LOWER(user_email) = LOWER(?)
      ORDER BY created_at DESC
      LIMIT ?
    )
  `).run(emailClean, emailClean, MAX_HISTORY_PER_USER);

  console.log(`[History] History saved for [${emailClean}] (entry #${info.lastInsertRowid})`);

  return {
    id: info.lastInsertRowid,
    user_email: emailClean,
    custom_name: name,
    extracted_code: extractedCode,
    language: language || 'auto',
    created_at: now,
    expires_at: expiresAt,
  };
}

function getExtractionHistory(email) {
  cleanupExpiredHistory();
  const emailClean = (email || '').toLowerCase().trim();
  const rows = db.prepare(`
    SELECT id, custom_name, extracted_code, language, created_at, expires_at
    FROM extraction_history
    WHERE LOWER(user_email) = LOWER(?)
    ORDER BY created_at DESC
    LIMIT ?
  `).all(emailClean, MAX_HISTORY_PER_USER);

  const now = Date.now();
  return rows.map(r => ({
    id: r.id,
    customName: r.custom_name,
    extractedCode: r.extracted_code,
    language: r.language,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    expiresInDays: Math.max(0, Math.ceil((r.expires_at - now) / (24 * 60 * 60 * 1000))),
  }));
}

/* ─── Auth middleware (optional — sets req.user if valid JWT present) ────── */
function authenticate(req, _res, next) {
  const auth = req.headers.authorization;
  req.user = null;
  if (auth && auth.startsWith('Bearer ')) {
    try {
      req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    } catch {
      /* expired or invalid — treat as anonymous */
    }
  }
  next();
}

/* ─── GET /api/anon/status ───────────────────────────────────────────────── */
app.get('/api/anon/status', (req, res) => {
  const ip = getClientIp(req);
  res.json(getAnonUsage(ip));
});

/* ─── POST /api/feedback ─────────────────────────────────────────────────── */
app.post('/api/feedback', authenticate, (req, res) => {
  try {
    const { type, description, page } = req.body || {};
    if (!type || typeof type !== 'string') {
      return res.status(400).json({ error: 'Issue type is required.' });
    }

    const validTypes = ['Wrong code extracted', 'Missing characters', "Crop didn't work", 'Other'];
    const issueType = validTypes.includes(type.trim()) ? type.trim() : 'Other';
    const descClean = (description || '').trim().slice(0, 500);
    const userEmail = req.user ? req.user.email : null;
    const pageClean = (page || 'index.html').trim().slice(0, 100);
    const now = new Date().toISOString();

    const stmt = db.prepare(`
      INSERT INTO feedback (type, description, timestamp, user_email, page)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(issueType, descClean, now, userEmail, pageClean);

    console.log(`[Feedback] New report #${result.lastInsertRowid}: [${issueType}] by ${userEmail || 'Anonymous'}`);
    res.json({ ok: true, id: result.lastInsertRowid });
  } catch (err) {
    console.error('[Feedback] Error saving feedback:', err.message);
    res.status(500).json({ error: 'Failed to submit report. Please try again.' });
  }
});

/* ─── Admin Config & Auth ────────────────────────────────────────────────── */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'codesnapper_admin_2026!';

function verifyAdminAuth(req) {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (token === ADMIN_PASSWORD) return true;
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded && decoded.role === 'admin') return true;
    } catch {}
  }
  const keyHeader = req.headers['x-admin-key'];
  if (keyHeader === ADMIN_PASSWORD) return true;
  if (req.query && req.query.key === ADMIN_PASSWORD) return true;
  return false;
}

/* ─── POST /api/admin/login ──────────────────────────────────────────────── */
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid admin password.' });
  }
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ ok: true, token });
});

/* ─── GET /api/admin/feedback ────────────────────────────────────────────── */
app.get('/api/admin/feedback', (req, res) => {
  if (!verifyAdminAuth(req)) {
    return res.status(401).json({ error: 'Admin authentication required.' });
  }
  const rows = db.prepare(`
    SELECT * FROM feedback
    ORDER BY id DESC
  `).all();
  res.json({ feedback: rows });
});

/* ─── DELETE /api/admin/feedback/:id ─────────────────────────────────────── */
app.delete('/api/admin/feedback/:id', (req, res) => {
  if (!verifyAdminAuth(req)) {
    return res.status(401).json({ error: 'Admin authentication required.' });
  }
  db.prepare('DELETE FROM feedback WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* ─── POST /api/admin/feedback/clear ─────────────────────────────────────── */
app.post('/api/admin/feedback/clear', (req, res) => {
  if (!verifyAdminAuth(req)) {
    return res.status(401).json({ error: 'Admin authentication required.' });
  }
  db.prepare('DELETE FROM feedback').run();
  res.json({ ok: true });
});

/* ─── POST /api/rate (Submit rating after 30th extraction) ───────────────── */
app.post('/api/rate', authenticate, (req, res) => {
  const { stars, feedback } = req.body || {};
  const starCount = parseInt(stars, 10);
  if (!starCount || starCount < 1 || starCount > 5) {
    return res.status(400).json({ error: 'Stars must be between 1 and 5.' });
  }
  const cleanFeedback = (feedback || '').trim().slice(0, 200);
  const email = req.user ? req.user.email.toLowerCase().trim() : 'anonymous';
  const now = Date.now();
  const timestamp = new Date(now).toISOString();

  db.prepare(`
    INSERT INTO ratings (stars, feedback, user_email, timestamp, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(starCount, cleanFeedback, email, timestamp, now);

  if (req.user) {
    db.prepare('UPDATE users SET has_rated = 1 WHERE LOWER(email) = LOWER(?)').run(email);
  }

  console.log(`[Ratings] New rating from [${email}]: ${starCount} stars${cleanFeedback ? ' - "' + cleanFeedback + '"' : ''}`);
  res.json({ ok: true });
});

/* ─── GET /api/admin/ratings ─────────────────────────────────────────────── */
app.get('/api/admin/ratings', (req, res) => {
  if (!verifyAdminAuth(req)) {
    return res.status(401).json({ error: 'Admin authentication required.' });
  }
  const rows = db.prepare(`
    SELECT * FROM ratings
    ORDER BY id DESC
  `).all();
  const total = rows.length;
  const avg = total > 0 ? (rows.reduce((sum, r) => sum + r.stars, 0) / total).toFixed(1) : '0.0';
  res.json({ ok: true, ratings: rows, total, average: avg });
});

/* ─── DELETE /api/admin/ratings/:id ──────────────────────────────────────── */
app.delete('/api/admin/ratings/:id', (req, res) => {
  if (!verifyAdminAuth(req)) {
    return res.status(401).json({ error: 'Admin authentication required.' });
  }
  db.prepare('DELETE FROM ratings WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* ─── GET /admin & /admin/feedback ───────────────────────────────────────── */
app.get(['/admin', '/admin/feedback'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

/* ─── POST /api/auth/register ────────────────────────────────────────────── */
app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password)
    return res.status(400).json({ error: 'Email and password are required.' });

  const emailClean = email.toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailClean))
    return res.status(400).json({ error: 'Please enter a valid email address.' });

  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  if (getUser(emailClean))
    return res.status(409).json({ error: 'An account with this email already exists — sign in instead.' });

  const passwordHash = await bcrypt.hash(password, 12);
  const now = Date.now();

  const newUser = {
    email: emailClean,
    passwordHash,
    createdAt:     now,
    windowStart:   now,
    countInWindow: 0,
  };
  saveUser(newUser);

  const token = jwt.sign({ email: emailClean }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
  console.log(`[Auth] Registered: ${emailClean}`);
  res.json({ token, email: emailClean, remaining: AUTH_LIMIT, limit: AUTH_LIMIT });
});

/* ─── POST /api/auth/login ───────────────────────────────────────────────── */
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password)
    return res.status(400).json({ error: 'Email and password are required.' });

  const emailClean = (email || '').toLowerCase().trim();
  const user = getUser(emailClean);

  console.log(`[Auth] Login attempt for [${emailClean}] — found: ${user ? 'yes' : 'no'}`);

  if (!user)
    return res.status(401).json({ error: 'No account found with this email.' });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid)
    return res.status(401).json({ error: 'Incorrect password. Please try again.' });

  refreshWindow(user);
  saveUser(user);

  const remaining = getRemaining(user);
  const token = jwt.sign({ email: emailClean }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
  console.log(`[Auth] Login: ${emailClean} — ${remaining} remaining today`);
  res.json({ token, email: emailClean, remaining, limit: AUTH_LIMIT,
             resetAt: user.windowStart + WINDOW_MS });
});

/* ─── GET /api/auth/me ───────────────────────────────────────────────────── */
app.get('/api/auth/me', authenticate, (req, res) => {
  if (!req.user)
    return res.status(401).json({ error: 'Please sign in to continue.' });

  const user = getUser(req.user.email);
  if (!user)
    return res.status(404).json({ error: 'Account not found. Please sign in again.' });

  refreshWindow(user);
  saveUser(user);

  const remaining = getRemaining(user);
  res.json({
    email:    req.user.email,
    remaining,
    limit:    AUTH_LIMIT,
    resetAt:  user.windowStart + WINDOW_MS,
  });
});

/* ─── GET /api/user/usage ─────────────────────────────────────────────────── */
app.get('/api/user/usage', authenticate, (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Please sign in to view your usage.' });
  }

  const user = getUser(req.user.email);
  if (!user) {
    return res.status(404).json({ error: 'Account not found. Please sign in again.' });
  }

  refreshWindow(user);
  saveUser(user);

  const used = user.countInWindow || 0;
  const remaining = Math.max(0, AUTH_LIMIT - used);
  const resetsAt = user.windowStart + WINDOW_MS;

  res.json({
    used,
    limit: AUTH_LIMIT,
    remaining,
    resets_at: resetsAt,
    resetAt: resetsAt,
  });
});

/* ─── GET /api/history ───────────────────────────────────────────────────── */
app.get('/api/history', authenticate, (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Please sign in to view your extraction history.' });
  }
  const history = getExtractionHistory(req.user.email);
  res.json({ ok: true, history });
});

/* ─── POST /api/history/save ─────────────────────────────────────────────── */
app.post('/api/history/save', authenticate, (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Please sign in to save your extraction history.' });
  }
  const { codeText, extractedCode, lang, language, customName, historyId } = req.body || {};
  const code = extractedCode || codeText;
  const languageName = language || lang || 'auto';

  // If historyId is provided, update the existing entry's language and name
  if (historyId) {
    const existing = db.prepare('SELECT * FROM extraction_history WHERE id = ? AND user_email = ?').get(historyId, req.user.email);
    if (existing) {
      const newName = customName || (existing.custom_name && !existing.custom_name.startsWith('Code ·')
        ? existing.custom_name
        : generateDefaultHistoryName(languageName, existing.created_at));
      db.prepare(`
        UPDATE extraction_history
        SET language = ?, custom_name = ?
        WHERE id = ? AND user_email = ?
      `).run(languageName, newName, historyId, req.user.email);
      return res.json({ ok: true, id: historyId, customName: newName, language: languageName });
    }
  }

  if (!code) {
    return res.status(400).json({ error: 'No code content found to save.' });
  }

  const entry = saveExtractionHistory(req.user.email, code, languageName, customName);
  res.json({ ok: true, entry });
});

/* ─── PUT /api/history/:id ───────────────────────────────────────────────── */
app.put('/api/history/:id', authenticate, (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Please sign in to manage your extraction history.' });
  }
  const id = parseInt(req.params.id, 10);
  const { customName } = req.body || {};
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: 'Invalid extraction item.' });
  }
  if (!customName || !customName.trim()) {
    return res.status(400).json({ error: 'Name cannot be empty.' });
  }

  const updatedName = customName.trim();
  const info = db.prepare(`
    UPDATE extraction_history
    SET custom_name = ?
    WHERE id = ? AND user_email = ?
  `).run(updatedName, id, req.user.email);

  if (info.changes === 0) {
    return res.status(404).json({ error: 'Extraction not found or already removed.' });
  }

  res.json({ ok: true, id, customName: updatedName });
});

/* ─── DELETE /api/history/:id ────────────────────────────────────────────── */
app.delete('/api/history/:id', authenticate, (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Please sign in to manage your extraction history.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: 'Invalid extraction item.' });
  }

  const info = db.prepare(`
    DELETE FROM extraction_history
    WHERE id = ? AND user_email = ?
  `).run(id, req.user.email);

  if (info.changes === 0) {
    return res.status(404).json({ error: 'Extraction not found or already removed.' });
  }

  res.json({ ok: true, id });
});

/* ─── Auth error classifier ──────────────────────────────────────────────── */
function classifyGeminiError(status, data) {
  const msg    = data?.error?.message || '';
  const reason = data?.error?.status  || data?.error?.errors?.[0]?.reason || '';
  const detail = { status, msg, reason, raw: JSON.stringify(data?.error || data) };

  if (status === 401 || reason === 'ACCESS_TOKEN_TYPE_UNSUPPORTED')
    return { ...detail, type: 'AUTH_TOKEN_UNSUPPORTED',
      friendly: 'Something went wrong on our end. Please try again shortly.' };
  if (status === 401 || msg.toLowerCase().includes('api key not valid'))
    return { ...detail, type: 'INVALID_KEY',
      friendly: 'Something went wrong on our end. Please try again shortly.' };
  if (status === 403)
    return { ...detail, type: 'ACCESS_DENIED',
      friendly: 'Something went wrong on our end. Please try again shortly.' };
  if (status === 429)
    return { ...detail, type: 'RATE_LIMIT',
      friendly: 'Our service is experiencing high demand right now. Please wait a few seconds and try again.' };
  if (status === 404 || msg.includes('not found') || msg.includes('not support'))
    return { ...detail, type: 'MODEL_NOT_FOUND', friendly: 'Extraction failed — our service is temporarily unavailable. Please try again in a moment.' };
  return { ...detail, type: 'API_ERROR', friendly: 'Extraction failed — our service is temporarily unavailable. Please try again in a moment.' };
}

const MODEL_TIMEOUT_MS = 15000; // 15 seconds timeout per model attempt

/* ─── Gemini strategies ──────────────────────────────────────────────────── */
async function tryOpenAIEndpoint(model, token, mimeType, imageData, timeoutMs = PER_MODEL_TIMEOUT_MS) {
  const body = {
    model,
    messages: [{ role: 'user', content: [
      { type: 'text', text: EXTRACTION_PROMPT },
      { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageData}` } },
    ]}],
    temperature: 0.05,
    max_tokens:  8192,
  };
  const res  = await fetch(GEMINI_OPENAI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body:   JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data, endpoint: 'openai-compat' };
}

async function tryNativeEndpoint(model, token, isBearer, requestBody, timeoutMs = PER_MODEL_TIMEOUT_MS) {
  const url = isBearer
    ? `${GEMINI_NATIVE_BASE}/${model}:generateContent`
    : `${GEMINI_NATIVE_BASE}/${model}:generateContent?key=${token}`;
  const headers = isBearer
    ? { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }
    : { 'Content-Type': 'application/json' };
  const res  = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data, endpoint: 'native' };
}

/* ─── POST /api/extract ──────────────────────────────────────────────────── */
app.post('/api/extract', authenticate, async (req, res) => {
  const imageStartTime = Date.now();

  /* ── 1. Get a fresh Gemini token (auto-refreshed for service accounts) ── */
  let cred;
  try {
    cred = await getGeminiToken();
  } catch (e) {
    const code = e.code || 'SERVER_CONFIG_ERROR';
    console.error('[CodeSnapper] ✗ Credential error:', e.message);
    if (code === 'TOKEN_EXPIRED') {
      return res.status(503).json({
        error: 'Something went wrong on our end. Please try again shortly.',
        code,
      });
    }
    return res.status(500).json({ error: 'Extraction failed — our service is temporarily unavailable. Please try again in a moment.', code });
  }

  let { token, mode, isBearer } = cred;

  /* ── 2. Auth-aware rate limiting (IP-based for anonymous, account-based for signed-in) ── */
  const clientIp = getClientIp(req);
  if (req.user) {
    const user = getUser(req.user.email);
    if (!user) {
      return res.status(401).json({ error: 'Account not found. Please sign in again.', code: 'AUTH_REQUIRED' });
    }
    refreshWindow(user);
    if (user.countInWindow >= AUTH_LIMIT) {
      const resetIn = Math.ceil((user.windowStart + WINDOW_MS - Date.now()) / 60000);
      return res.status(429).json({
        error:   `Daily limit reached (${AUTH_LIMIT}/day). Resets in ${resetIn} minute${resetIn !== 1 ? 's' : ''}.`,
        code:    'DAILY_LIMIT',
        resetAt: user.windowStart + WINDOW_MS,
      });
    }
  } else {
    // Anonymous users: server-side IP tracking in SQLite
    const anonUsage = getAnonUsage(clientIp);
    if (anonUsage.count >= ANON_LIMIT) {
      return res.status(429).json({
        error: `You’ve reached the limit of ${ANON_LIMIT} free extractions without an account. Please sign in or create a free account for 50 extractions per day.`,
        code:  'ANON_LIMIT_REACHED',
        remaining: 0,
        limit: ANON_LIMIT,
      });
    }
  }

  /* ── 3. Validate request ── */
  const { imageData, mimeType } = req.body;
  if (!imageData || typeof imageData !== 'string')
    return res.status(400).json({ error: 'Please upload a valid image file and try again.', code: 'BAD_REQUEST' });
  if (!mimeType || !mimeType.startsWith('image/'))
    return res.status(400).json({ error: 'Please upload a valid image file (PNG, JPG, WEBP, GIF).', code: 'BAD_REQUEST' });

  const userLabel = req.user ? req.user.email : `anonymous (${clientIp})`;
  console.log(`\n[CodeSnapper] Extract ← ${userLabel} [cred: ${mode}]`);

  /* ── 4. Build native request body ── */
  const nativeBody = {
    contents: [{ parts: [
      { text: EXTRACTION_PROMPT },
      { inline_data: { mime_type: mimeType, data: imageData } },
    ]}],
    generationConfig: { temperature: 0.05, maxOutputTokens: 8192, topP: 0.9 },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ],
  };

  /* ── 5. Try strategies ── */
  const strategies = isBearer ? ['native', 'openai-compat'] : ['native'];
  let hardAuthError = null;
  let rateLimitError = null;
  let totalTimeoutExceeded = false;

  for (const model of GEMINI_MODELS) {
    const elapsedBeforeModel = Date.now() - imageStartTime;
    if (elapsedBeforeModel >= MAX_IMAGE_TOTAL_TIMEOUT_MS) {
      console.warn(`[CodeSnapper] ⏱ Image reached 15s total limit (${elapsedBeforeModel}ms). Skipping further model attempts.`);
      totalTimeoutExceeded = true;
      break;
    }

    const currentAttemptTimeoutMs = Math.min(PER_MODEL_TIMEOUT_MS, MAX_IMAGE_TOTAL_TIMEOUT_MS - elapsedBeforeModel);

    for (const strategy of strategies) {
      const elapsedBeforeAttempt = Date.now() - imageStartTime;
      if (elapsedBeforeAttempt >= MAX_IMAGE_TOTAL_TIMEOUT_MS) {
        totalTimeoutExceeded = true;
        break;
      }

      try {
        console.log(`[CodeSnapper]   ${strategy}/${model} (timeout: ${currentAttemptTimeoutMs}ms)…`);
        const { res: gemRes, data, endpoint } = strategy === 'openai-compat'
          ? await tryOpenAIEndpoint(model, token, mimeType, imageData, currentAttemptTimeoutMs)
          : await tryNativeEndpoint(model, token, isBearer, nativeBody, currentAttemptTimeoutMs);

        if (gemRes.ok) {
          const text = endpoint === 'openai-compat'
            ? data?.choices?.[0]?.message?.content
            : data?.candidates?.[0]?.content?.parts?.[0]?.text;

          if (!text && data?.candidates?.[0]?.finishReason === 'SAFETY') {
            return res.status(422).json({ error: 'This image could not be processed. Please crop closely around the code and try again.', code: 'SAFETY_BLOCK' });
          }
          if (!text) { continue; }

          /* ── Record API success and timing ── */
          const totalDurationMs = Date.now() - imageStartTime;
          _lastSuccessfulApiCall = new Date().toISOString();
          _totalSuccessfulCalls++;
          console.log(`[CodeSnapper] ✓ Image extraction completed in ${totalDurationMs}ms (${(totalDurationMs / 1000).toFixed(2)}s) [${endpoint}/${model}]`);

          /* ── Increment usage counter ── */
          let remaining = null;
          let shouldPromptRating = false;
          let totalExtractions = 0;
          if (req.user) {
            const user = getUser(req.user.email);
            if (user) {
              refreshWindow(user);
              user.countInWindow = (user.countInWindow || 0) + 1;
              saveUser(user);
              remaining = Math.max(0, AUTH_LIMIT - user.countInWindow);
            }
            db.prepare('UPDATE users SET total_extractions = COALESCE(total_extractions, 0) + 1 WHERE LOWER(email) = LOWER(?)').run(req.user.email);
            const userRow = db.prepare('SELECT total_extractions, has_rated FROM users WHERE LOWER(email) = LOWER(?)').get(req.user.email);
            if (userRow) {
              totalExtractions = userRow.total_extractions || 0;
              if (totalExtractions === 30 && !userRow.has_rated) {
                shouldPromptRating = true;
              }
            }
            const historyEntry = saveExtractionHistory(req.user.email, text, 'auto');
            return res.json({ result: text, model, endpoint, remaining, durationMs: totalDurationMs, historyEntry, shouldPromptRating, totalExtractions });
          } else {
            // Anonymous IP tracking in SQLite
            const newAnon = incAnonUsage(clientIp);
            remaining = newAnon.remaining;
            return res.json({ result: text, model, endpoint, remaining, durationMs: totalDurationMs });
          }
        }

        const err = classifyGeminiError(gemRes.status, data);
        console.error(`[CodeSnapper] ✗ Attempt failed: model="${model}" endpoint="${endpoint}" | [${err.type}] ${err.msg}`);

        if (err.type === 'RATE_LIMIT') {
          console.warn(`[CodeSnapper] ⚠ Rate limit (HTTP 429) on ${endpoint}/${model}, failing over to next model immediately…`);
          rateLimitError = err;
          continue;
        }

        if (['AUTH_TOKEN_UNSUPPORTED', 'INVALID_KEY', 'ACCESS_DENIED'].includes(err.type)) {
          // If bearer token was rejected (e.g. Generative Language API restricting service accounts),
          // check if a static GEMINI_API_KEY is available and fallback immediately!
          const staticKey = (process.env.GEMINI_API_KEY || '').trim();
          if (isBearer && staticKey && staticKey !== token) {
            console.warn(`[Auth] ⚠ Service account bearer token rejected (${err.msg}). Falling back to static GEMINI_API_KEY (${staticKey.slice(0, 10)}…)`);
            token = staticKey;
            isBearer = false;
            _isServiceAccountActive = false;
            // Retry this model immediately with the static key
            const fallbackRes = await tryNativeEndpoint(model, token, false, nativeBody, Math.min(PER_MODEL_TIMEOUT_MS, MAX_IMAGE_TOTAL_TIMEOUT_MS - (Date.now() - imageStartTime)));
            if (fallbackRes.res.ok) {
              const text = fallbackRes.data?.candidates?.[0]?.content?.parts?.[0]?.text;
              if (text) {
                const totalDurationMs = Date.now() - imageStartTime;
                _lastSuccessfulApiCall = new Date().toISOString();
                _totalSuccessfulCalls++;
                console.log(`[CodeSnapper] ✓ Image extraction completed in ${totalDurationMs}ms (${(totalDurationMs / 1000).toFixed(2)}s) [fallback native/${model}]`);
                let remaining = null;
                let shouldPromptRating = false;
                let totalExtractions = 0;
                if (req.user) {
                  const user = getUser(req.user.email);
                  if (user) {
                    refreshWindow(user);
                    user.countInWindow = (user.countInWindow || 0) + 1;
                    saveUser(user);
                    remaining = Math.max(0, AUTH_LIMIT - user.countInWindow);
                  }
                  db.prepare('UPDATE users SET total_extractions = COALESCE(total_extractions, 0) + 1 WHERE LOWER(email) = LOWER(?)').run(req.user.email);
                  const userRow = db.prepare('SELECT total_extractions, has_rated FROM users WHERE LOWER(email) = LOWER(?)').get(req.user.email);
                  if (userRow) {
                    totalExtractions = userRow.total_extractions || 0;
                    if (totalExtractions === 30 && !userRow.has_rated) {
                      shouldPromptRating = true;
                    }
                  }
                  const historyEntry = saveExtractionHistory(req.user.email, text, 'auto');
                  return res.json({ result: text, model, endpoint: 'native-fallback', remaining, durationMs: totalDurationMs, historyEntry, shouldPromptRating, totalExtractions });
                } else {
                  const newAnon = incAnonUsage(clientIp);
                  remaining = newAnon.remaining;
                  return res.json({ result: text, model, endpoint: 'native-fallback', remaining, durationMs: totalDurationMs });
                }
              }
            }
          }

          // If service account is configured, try emergency token refresh once
          if (!hardAuthError && (_isServiceAccountActive || findServiceAccountRaw())) {
            console.log('[Auth] ⚠ Auth error encountered during extraction. Attempting emergency token refresh…');
            try {
              const freshToken = await refreshTokenIfNeeded(true);
              if (freshToken && freshToken !== token) {
                token = freshToken;
                isBearer = freshToken.startsWith('ya29.');
                console.log(`[Auth] ✓ Emergency token refreshed (${token.slice(0, 10)}…). Retrying request…`);
                continue;
              }
            } catch (refErr) {
              console.error('[Auth] ✗ Emergency refresh failed:', refErr.message);
            }
          }
          hardAuthError = err; break;
        }

      } catch (networkErr) {
        const attemptDuration = Date.now() - imageStartTime;
        if (networkErr.name === 'AbortError' || networkErr.name === 'TimeoutError') {
          console.warn(`[CodeSnapper] ⏱ Timeout (${currentAttemptTimeoutMs}ms) on model="${model}" endpoint="${strategy}" after ${attemptDuration}ms. Failing over to next model immediately…`);
        } else {
          console.error(`[CodeSnapper] ✗ Network error on model="${model}" endpoint="${strategy}":`, networkErr.message);
        }
      }
    }
    if (hardAuthError || totalTimeoutExceeded) break;
  }

  if (totalTimeoutExceeded) {
    console.error(`[CodeSnapper] ✗ Image extraction timed out: exceeded total timeout of 20s (${Date.now() - imageStartTime}ms) across attempted models: ${GEMINI_MODELS.join(', ')}`);
    return res.status(504).json({
      error: 'Extraction took longer than expected. Please try a tighter crop or check your connection.',
      code: 'IMAGE_TIMEOUT',
    });
  }

  if (hardAuthError) {
    console.error('\n[CodeSnapper] ══ AUTH FAILURE ═══════════════════');
    console.error(`  ${hardAuthError.type}: ${hardAuthError.msg}`);
    console.error('  Check your environment variables.\n');
    return res.status(401).json({ error: 'Something went wrong on our end. Please try again shortly.', code: 'INVALID_API_KEY' });
  }

  if (rateLimitError) {
    return res.status(429).json({
      error: 'Our service is experiencing high demand right now. Please wait a few seconds and try again.',
      code:  'RATE_LIMIT',
    });
  }

  console.error(`[CodeSnapper] ✗ All models failed for image! Attempted models: ${GEMINI_MODELS.join(' → ')} | Total elapsed: ${Date.now() - imageStartTime}ms`);
  return res.status(502).json({
    error: 'Extraction failed — our service is temporarily unavailable. Please try again in a moment.',
    code:  'ALL_MODELS_FAILED',
  });
});

/* ─── Health check endpoint (/health & /api/health) ───────────────────────── */
app.get(['/health', '/api/health'], (_req, res) => {
  const isAuthOk = !!_cachedToken && !_lastAuthError;
  res.json({
    auth: isAuthOk ? 'ok' : 'failed',
    method: _isServiceAccountActive ? 'service-account' : (_cachedToken ? 'api-key' : 'none'),
    lastSuccess: _lastSuccessfulApiCall,
    totalSuccess: _totalSuccessfulCalls,
    credentialPrefix: _cachedToken ? `${_cachedToken.slice(0, 10)}...` : 'none',
    serviceAccountEmail: _serviceAccountEmail,
    models: GEMINI_MODELS,
    perModelTimeoutMs: PER_MODEL_TIMEOUT_MS,
    maxImageTotalTimeoutMs: MAX_IMAGE_TOTAL_TIMEOUT_MS,
    serverTime: new Date().toISOString(),
    status: isAuthOk ? 'ok' : 'error',
    error: _lastAuthError
  });
});

/* ─── Direct live Gemini test endpoint ───────────────────────────────────── */
app.get('/api/test-gemini', async (_req, res) => {
  const log = [];
  const start = Date.now();
  try {
    const cred = await getGeminiToken();
    log.push(`Cred: mode=${cred.mode}, isBearer=${cred.isBearer}, format=${cred.format}, tokenPrefix=${cred.token.slice(0, 10)}...`);

    const testBody = { contents: [{ parts: [{ text: 'Respond with OK' }] }] };
    const r1 = await tryNativeEndpoint('gemini-3.5-flash-lite', cred.token, cred.isBearer, testBody, 4000);
    log.push(`Attempt 1 (gemini-3.5-flash-lite, isBearer=${cred.isBearer}): status=${r1.res.status}, data=${JSON.stringify(r1.data).slice(0, 250)}`);

    const envKey = (process.env.GEMINI_API_KEY || '').trim();
    if (!r1.res.ok && envKey) {
      const r2 = await tryNativeEndpoint('gemini-3.5-flash-lite', envKey, false, testBody, 4000);
      log.push(`Attempt 2 (fallback to GEMINI_API_KEY=${envKey.slice(0, 10)}...): status=${r2.res.status}, data=${JSON.stringify(r2.data).slice(0, 250)}`);
    }

    res.json({ ok: true, durationMs: Date.now() - start, log });
  } catch (e) {
    res.json({ ok: false, durationMs: Date.now() - start, error: e.message, log });
  }
});

/* ─── SPA fallback ───────────────────────────────────────────────────────── */
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

/* ─── Startup ────────────────────────────────────────────────────────────── */
(async () => {
  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║          CodeSnapper is starting           ║');
  console.log('╚════════════════════════════════════════════╝');

  const rawCred = findServiceAccountRaw();
  const staticKey = (process.env.GEMINI_API_KEY || '').trim();

  // Priority 3: If neither exists → crash immediately on startup
  if (!rawCred && (!staticKey || staticKey === 'your_gemini_api_key_here')) {
    console.error('\n❌ CRITICAL STARTUP ERROR:');
    console.error('NO CREDENTIALS FOUND — set GEMINI_API_KEY or GOOGLE_SERVICE_ACCOUNT_JSON in environment');
    console.error('Shutting down server immediately.\n');
    process.exit(1);
  }

  // Priority 1: If GOOGLE_SERVICE_ACCOUNT_JSON exists in environment → use google-auth-library to mint tokens
  if (rawCred) {
    console.log(`[Auth] Priority 1: Service Account detected in ${rawCred.key}. Minting token via google-auth-library...`);
    try {
      await refreshTokenIfNeeded(true);
    } catch (err) {
      console.error('[Auth] ✗ Service account initial token minting failed:', err.message);
      if (!staticKey || staticKey === 'your_gemini_api_key_here') {
        console.error('\n❌ CRITICAL ERROR: Service account authentication failed and no static GEMINI_API_KEY provided.');
        console.error('NO CREDENTIALS FOUND — set GEMINI_API_KEY or GOOGLE_SERVICE_ACCOUNT_JSON in environment\n');
        process.exit(1);
      }
    }
  }

  // Priority 2: If only GEMINI_API_KEY exists → use it as a static key via ?key= query param
  if (!_isServiceAccountActive && staticKey && staticKey !== 'your_gemini_api_key_here') {
    _cachedToken = staticKey;
    _tokenLoadedAt = Date.now();
    _isServiceAccountActive = false;
    const prefix = staticKey.slice(0, 10);
    console.log(`[Auth] Priority 2: Using static key from GEMINI_API_KEY (${prefix}…) via ?key= query param`);
    console.warn(`[Auth] ⚠ WARNING: Using static GEMINI_API_KEY. It may expire hourly if using an authorization token.`);
  }

  console.log('─────────────────────────────────────────────────────────────');
  console.log(`[Auth] Status:            ${_cachedToken ? 'OK' : 'FAILED'}`);
  console.log(`[Auth] Active Method:     ${_isServiceAccountActive ? 'service-account' : 'api-key'}`);
  console.log(`[Auth] Loaded Credential: ${_cachedToken ? _cachedToken.slice(0, 10) + '...' : 'none'}`);
  if (_isServiceAccountActive) {
    console.log(`[Auth] Service Account:   ${_serviceAccountEmail}`);
    console.log(`[Auth] Auto-refresh:      ✓ ENABLED — token will refresh automatically every 45 minutes`);
  }
  console.log('─────────────────────────────────────────────────────────────');

  // Auto-refresh every 45 minutes for service accounts
  if (_isServiceAccountActive || rawCred) {
    setInterval(async () => {
      try {
        console.log(`[Auth] [${new Date().toISOString()}] Scheduled 45-minute background auto-refresh running…`);
        await refreshTokenIfNeeded(true);
      } catch (err) {
        console.error(`[Auth] [${new Date().toISOString()}] ✗ Scheduled 45-minute background refresh error:`, err.message);
      }
    }, TOKEN_REFRESH_INTERVAL_MS);
  }

  app.listen(PORT, () => {
    console.log(`  URL:      http://localhost:${PORT}`);
    console.log(`  Health:   http://localhost:${PORT}/health`);
    console.log(`  Models:   ${GEMINI_MODELS.join(' → ')}`);
    console.log(`  Timeouts: ${PER_MODEL_TIMEOUT_MS/1000}s per model attempt | ${MAX_IMAGE_TOTAL_TIMEOUT_MS/1000}s max per image`);
    console.log(`  Auth:     JWT (30-day tokens, bcrypt passwords)`);
    console.log(`  Limits:   Anon=25 total  |  Signed-in=${AUTH_LIMIT}/24h rolling\n`);
  });
})();
