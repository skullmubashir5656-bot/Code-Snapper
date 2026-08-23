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

const GEMINI_MODELS = [
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-2.5-flash-lite',
  'gemini-flash-latest',
];

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

/* ─── Credential resolver ────────────────────────────────────────────────── */
/*
 * Auto-detects Gemini API Keys (supporting AQ. and AIza formats) and routes them via ?key= parameter.
 */

const GEMINI_SCOPES = ['https://www.googleapis.com/auth/generative-language'];

let _saClient = null;

async function _initServiceAccount() {
  if (!GoogleAuth) return null;
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) return null;

  try {
    const credentials = JSON.parse(raw);
    const auth = new GoogleAuth({ credentials, scopes: GEMINI_SCOPES });
    _saClient = await auth.getClient();
    return _saClient;
  } catch (e) {
    return null;
  }
}

/**
 * Returns the credential to use for this request.
 * Auto-detects key format and configures appropriate parameter delivery.
 * @returns {{ token: string, mode: string, isBearer: boolean, format: string }}
 */
async function getGeminiToken() {
  const envKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!envKey || envKey === 'your_gemini_api_key_here') {
    const err = new Error('No Gemini API key configured.');
    err.code = 'SERVER_CONFIG_ERROR';
    throw err;
  }

  const format = envKey.startsWith('AQ.') ? 'AQ.' : envKey.startsWith('AIza') ? 'AIza' : 'Standard';

  // All Gemini API Keys (AQ., AIza, etc.) are delivered via ?key= query parameter
  return { token: envKey, mode: 'api-key', isBearer: false, format };
}

/* ─── Middleware ─────────────────────────────────────────────────────────── */
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname)));

/* ─── SQLite Database Initialization ─────────────────────────────────────── */
const Database = require('better-sqlite3');
const DB_FILE  = path.join(__dirname, 'codesnapper.db');
const db       = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

// Table schema
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
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
  CREATE TABLE IF NOT EXISTS extraction_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email TEXT NOT NULL,
    code_text TEXT NOT NULL,
    lang TEXT NOT NULL DEFAULT 'auto',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    description TEXT,
    timestamp TEXT NOT NULL,
    user_email TEXT,
    page TEXT
  );
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
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!row) return null;
  return {
    email: row.email,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    windowStart: row.window_start,
    countInWindow: row.count_in_window,
  };
}

function saveUser(user) {
  db.prepare(`
    INSERT INTO users (email, password_hash, created_at, window_start, count_in_window)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      password_hash = excluded.password_hash,
      created_at = excluded.created_at,
      window_start = excluded.window_start,
      count_in_window = excluded.count_in_window
  `).run(user.email, user.passwordHash, user.createdAt, user.windowStart, user.countInWindow);
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

/* ─── Extraction History Helpers (7-day retention, max 10 per user) ───────── */
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function cleanOldHistory() {
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  db.prepare('DELETE FROM extraction_history WHERE created_at < ?').run(cutoff);
}

function saveExtractionHistory(email, codeText, lang = 'auto') {
  if (!email || !codeText) return;
  cleanOldHistory();
  const now = Date.now();
  db.prepare(`
    INSERT INTO extraction_history (user_email, code_text, lang, created_at)
    VALUES (?, ?, ?, ?)
  `).run(email, codeText, lang || 'auto', now);

  db.prepare(`
    DELETE FROM extraction_history
    WHERE user_email = ? AND id NOT IN (
      SELECT id FROM extraction_history
      WHERE user_email = ?
      ORDER BY created_at DESC
      LIMIT 10
    )
  `).run(email, email);
}

function getExtractionHistory(email) {
  cleanOldHistory();
  const rows = db.prepare(`
    SELECT id, code_text, lang, created_at
    FROM extraction_history
    WHERE user_email = ?
    ORDER BY created_at DESC
    LIMIT 10
  `).all(email);

  return rows.map(r => ({
    id: r.id,
    codeText: r.code_text,
    lang: r.lang,
    createdAt: r.created_at,
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

/* ─── GET /api/history ───────────────────────────────────────────────────── */
app.get('/api/history', authenticate, (req, res) => {
  if (!req.user)
    return res.status(401).json({ error: 'Authentication required.' });
  const history = getExtractionHistory(req.user.email);
  res.json({ history });
});

/* ─── POST /api/history/save ─────────────────────────────────────────────── */
app.post('/api/history/save', authenticate, (req, res) => {
  if (!req.user)
    return res.status(401).json({ error: 'Authentication required.' });
  const { codeText, lang } = req.body || {};
  if (!codeText)
    return res.status(400).json({ error: 'Missing codeText.' });
  saveExtractionHistory(req.user.email, codeText, lang);
  res.json({ status: 'ok', history: getExtractionHistory(req.user.email) });
});

/* ─── DELETE /api/history/:id ────────────────────────────────────────────── */
app.delete('/api/history/:id', authenticate, (req, res) => {
  if (!req.user)
    return res.status(401).json({ error: 'Authentication required.' });
  db.prepare('DELETE FROM extraction_history WHERE id = ? AND user_email = ?').run(req.params.id, req.user.email);
  res.json({ status: 'ok' });
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
    res.status(500).json({ error: 'Failed to save feedback.' });
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
    return res.status(409).json({ error: 'An account with this email already exists. Try signing in.' });

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

  const emailClean = email.toLowerCase().trim();
  const user = getUser(emailClean);

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
    return res.status(401).json({ error: 'Not authenticated.' });

  const user = getUser(req.user.email);
  if (!user)
    return res.status(404).json({ error: 'Account not found.' });

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

/* ─── Auth error classifier ──────────────────────────────────────────────── */
function classifyGeminiError(status, data) {
  const msg    = data?.error?.message || '';
  const reason = data?.error?.status  || data?.error?.errors?.[0]?.reason || '';
  const detail = { status, msg, reason, raw: JSON.stringify(data?.error || data) };

  if (status === 401 || reason === 'ACCESS_TOKEN_TYPE_UNSUPPORTED')
    return { ...detail, type: 'AUTH_TOKEN_UNSUPPORTED',
      friendly: 'Your AQ. key was rejected (unsupported token type). AQ. tokens expire after ~1 hour — generate a fresh one, or use an AIza API key from https://aistudio.google.com/app/apikey' };
  if (status === 401 || msg.toLowerCase().includes('api key not valid'))
    return { ...detail, type: 'INVALID_KEY',
      friendly: 'Authentication failed. Check GEMINI_API_KEY in .env.' };
  if (status === 403)
    return { ...detail, type: 'ACCESS_DENIED',
      friendly: 'Access denied. Ensure the Generative Language API is enabled.' };
  if (status === 429)
    return { ...detail, type: 'RATE_LIMIT',
      friendly: 'Rate limit reached. Please wait a moment and try again.' };
  if (status === 404 || msg.includes('not found') || msg.includes('not support'))
    return { ...detail, type: 'MODEL_NOT_FOUND', friendly: 'Model not available.' };
  return { ...detail, type: 'API_ERROR', friendly: msg || `Gemini API error (HTTP ${status})` };
}

const MODEL_TIMEOUT_MS = 8000; // 8 seconds timeout per model attempt

/* ─── Gemini strategies ──────────────────────────────────────────────────── */
async function tryOpenAIEndpoint(model, token, mimeType, imageData) {
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
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data, endpoint: 'openai-compat' };
}

async function tryNativeEndpoint(model, token, isBearer, requestBody) {
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
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data, endpoint: 'native' };
}

/* ─── POST /api/extract ──────────────────────────────────────────────────── */
app.post('/api/extract', authenticate, async (req, res) => {

  /* ── 1. Get a fresh Gemini token (auto-refreshed for service accounts) ── */
  let cred;
  try {
    cred = await getGeminiToken();
  } catch (e) {
    const code = e.code || 'SERVER_CONFIG_ERROR';
    console.error('[CodeSnapper] ✗ Credential error:', e.message);
    if (code === 'TOKEN_EXPIRED') {
      return res.status(503).json({
        error: 'The server\'s API credentials have expired. Please try again later.',
        code,
      });
    }
    return res.status(500).json({ error: 'Server not configured. Please contact the administrator.', code });
  }

  const { token, mode, isBearer } = cred;

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
    return res.status(400).json({ error: 'Missing or invalid imageData.', code: 'BAD_REQUEST' });
  if (!mimeType || !mimeType.startsWith('image/'))
    return res.status(400).json({ error: 'Missing or invalid mimeType.', code: 'BAD_REQUEST' });

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
  const strategies = isBearer ? ['openai-compat', 'native'] : ['native'];
  let hardAuthError = null;
  let rateLimitError = null;

  for (const model of GEMINI_MODELS) {
    for (const strategy of strategies) {
      try {
        console.log(`[CodeSnapper]   ${strategy}/${model}…`);
        const { res: gemRes, data, endpoint } = strategy === 'openai-compat'
          ? await tryOpenAIEndpoint(model, token, mimeType, imageData)
          : await tryNativeEndpoint(model, token, isBearer, nativeBody);

        if (gemRes.ok) {
          const text = endpoint === 'openai-compat'
            ? data?.choices?.[0]?.message?.content
            : data?.candidates?.[0]?.content?.parts?.[0]?.text;

          if (!text && data?.candidates?.[0]?.finishReason === 'SAFETY') {
            return res.status(422).json({ error: 'Image blocked by safety filters. Try a tighter crop.', code: 'SAFETY_BLOCK' });
          }
          if (!text) { continue; }

          /* ── Increment usage counter ── */
          let remaining = null;
          if (req.user) {
            const user = getUser(req.user.email);
            if (user) {
              refreshWindow(user);
              user.countInWindow = (user.countInWindow || 0) + 1;
              saveUser(user);
              remaining = Math.max(0, AUTH_LIMIT - user.countInWindow);
            }
            saveExtractionHistory(req.user.email, text, 'auto');
          } else {
            // Anonymous IP tracking in SQLite
            const newAnon = incAnonUsage(clientIp);
            remaining = newAnon.remaining;
          }

          console.log(`[CodeSnapper] ✓ ${endpoint}/${model} — ${text.length} chars (remaining: ${remaining})`);
          return res.json({ result: text, model, endpoint, remaining });
        }

        const err = classifyGeminiError(gemRes.status, data);
        console.error(`[CodeSnapper] ✗ ${endpoint}/${model} [${err.type}] ${err.msg}`);

        if (err.type === 'RATE_LIMIT') {
          console.warn(`[CodeSnapper] ⚠ Rate limit (HTTP 429) on ${endpoint}/${model}, failing over to next model…`);
          rateLimitError = err;
          // Short 500ms delay to allow burst quota to cool down before trying next model
          await new Promise(r => setTimeout(r, 500));
          continue;
        }
        if (['AUTH_TOKEN_UNSUPPORTED','INVALID_KEY','ACCESS_DENIED'].includes(err.type)) {
          hardAuthError = err; break;
        }

      } catch (networkErr) {
        if (networkErr.name === 'AbortError' || networkErr.name === 'TimeoutError') {
          console.warn(`[CodeSnapper] ⏱ Timeout (${MODEL_TIMEOUT_MS/1000}s) for ${strategy}/${model}, failing over to next model…`);
        } else {
          console.error(`[CodeSnapper] ✗ Network (${strategy}/${model}):`, networkErr.message);
        }
      }
    }
    if (hardAuthError) break;
  }

  if (hardAuthError) {
    console.error('\n[CodeSnapper] ══ AUTH FAILURE ═══════════════════');
    console.error(`  ${hardAuthError.type}: ${hardAuthError.msg}`);
    console.error('  Check your environment variables.\n');
    return res.status(401).json({ error: 'The server could not authenticate with Gemini. Please try again later.', code: 'INVALID_API_KEY' });
  }

  if (rateLimitError) {
    return res.status(429).json({
      error: 'Gemini AI is currently experiencing high traffic. Please wait a few seconds and try again.',
      code:  'RATE_LIMIT',
    });
  }

  return res.status(502).json({
    error: 'Could not reach Gemini API after trying all models. Check your internet connection.',
    code:  'ALL_MODELS_FAILED',
  });
});

/* ─── Health check ───────────────────────────────────────────────────────── */
app.get('/api/health', (_req, res) => {
  const envKey = (process.env.GEMINI_API_KEY || '').trim();
  const format = envKey.startsWith('AQ.') ? 'AQ.' : envKey.startsWith('AIza') ? 'AIza' : envKey ? 'Standard' : 'none';
  res.json({
    status:   'ok',
    keyReady: format !== 'none',
    credMode: 'api-key',
    keyFormat: format,
    models:   GEMINI_MODELS,
    stable:   true,
  });
});

/* ─── SPA fallback ───────────────────────────────────────────────────────── */
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

/* ─── Startup ────────────────────────────────────────────────────────────── */
(async () => {
  const envKey = (process.env.GEMINI_API_KEY || '').trim();
  const format = envKey.startsWith('AQ.') ? 'AQ.' : envKey.startsWith('AIza') ? 'AIza' : envKey ? 'Standard' : 'none';

  if (format !== 'none') {
    console.log(`[Creds] Gemini API Key detected (prefix: ${format})`);
    console.log('[Creds]   delivery: ?key= query parameter (Google Gemini API Standard)');
    console.log('[Creds]   status  : Active & Ready');
  } else {
    console.error('[Creds] ✗ No GEMINI_API_KEY configured in .env!');
  }

  app.listen(PORT, () => {
    const credLabel = format !== 'none'
      ? `✓ API Key active (${format} format — ?key= parameter)`
      : '✗ NOT CONFIGURED';

    console.log('\n╔════════════════════════════════════════════╗');
    console.log('║          CodeSnapper is running            ║');
    console.log('╚════════════════════════════════════════════╝');
    console.log(`  URL:      http://localhost:${PORT}`);
    console.log(`  Models:   ${GEMINI_MODELS.join(' → ')}`);
    console.log(`  Creds:    ${credLabel}`);
    console.log(`  Auth:     JWT (30-day tokens, bcrypt passwords)`);
    console.log(`  Limits:   Anon=25 total  |  Signed-in=${AUTH_LIMIT}/24h rolling\n`);
  });
})();
