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
/* ─── OpenRouter config ──────────────────────────────────────────────────── */
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1/chat/completions';

// Free vision-capable models on OpenRouter:
const GEMINI_MODELS = [
  'google/gemini-2.5-flash-lite',  // free, fast
  'google/gemini-2.5-flash',       // free fallback
  'meta-llama/llama-3.2-11b-vision-instruct:free', // backup free model
];

const PER_MODEL_TIMEOUT_MS       = 10000; // 10 seconds max per model attempt (generous for dense vision images)
const MAX_IMAGE_TOTAL_TIMEOUT_MS = 22000; // 22 seconds max per image across models combined

const EXTRACTION_PROMPT = `You are CodeSnapper — a precision code extraction engine. Your ONLY task is to transcribe the source code visible in this image.

IMPORTANT: The image may be rotated, taken at an angle, in portrait or landscape orientation, or photographed from a screen. Mentally correct for any rotation or perspective and extract the code as if the image were perfectly straight.

STRICT OUTPUT FORMAT — FOLLOW EXACTLY:
1. On the very FIRST line, output the detected programming language in this exact format:
   # LANGUAGE: <language>
   Examples: # LANGUAGE: python, # LANGUAGE: javascript, # LANGUAGE: typescript, # LANGUAGE: html, # LANGUAGE: css, # LANGUAGE: java, # LANGUAGE: cpp, # LANGUAGE: csharp, # LANGUAGE: sql, # LANGUAGE: php, # LANGUAGE: ruby, # LANGUAGE: go, # LANGUAGE: rust, # LANGUAGE: bash
   If the language cannot be identified with certainty, output: # LANGUAGE: Code
2. On subsequent lines, output ONLY the transcribed source code.
3. Do NOT wrap in markdown code fences (no \`\`\` blocks).
4. Do NOT add any explanations, preambles, comments, or descriptions.
5. Preserve EXACT indentation — spaces and tabs exactly as shown.
6. Preserve ALL special characters exactly: : ; , . ( ) [ ] { } < > / \\ | + - * = ! @ # $ % ^ & ~ ? ' " \` newlines etc.
7. Preserve EXACT line breaks — every line of code on its own line.
8. Do NOT modify, fix, or "improve" the code — transcribe it EXACTLY as displayed.
9. After the code, if you are uncertain about ANY characters, add a blank line then:
   # AMBIGUOUS: line [N]: '[char]' could be '[alternative]'
10. If the image does NOT contain source code or programming language code, output EXACTLY: # NO_CODE_FOUND

Transcribe the code now:`;

/* ─── OpenRouter Credentials & Tracking ──────────────────────────────────── */
let _lastSuccessfulApiCall = null;
let _totalSuccessfulCalls = 0;

/**
 * Returns the OpenRouter API Key from environment.
 * @returns {{ token: string, mode: string, isBearer: boolean, format: string }}
 */
async function getOpenRouterToken() {
  const apiKey = (process.env.OPENROUTER_API_KEY || '').trim();
  if (!apiKey || apiKey === 'your_openrouter_api_key_here') {
    const err = new Error('No valid OPENROUTER_API_KEY configured in environment variables.');
    err.code = 'SERVER_CONFIG_ERROR';
    throw err;
  }

  const format = apiKey.startsWith('sk-or-') ? 'sk-or-' : 'OpenRouter Key';

  return {
    token: apiKey,
    mode: 'openrouter',
    isBearer: true,
    format,
  };
}

// Legacy alias
const getGeminiToken = getOpenRouterToken;

/* ─── Middleware ─────────────────────────────────────────────────────────── */
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname)));

/* ─── Persistent External Database Connection (Turso / SQLite Fallback) ────── */
const { createClient } = require('@libsql/client');
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
  return localPath;
}

const DB_FILE = resolveDatabasePath();
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

const TURSO_URL   = (process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL || '').trim();
const TURSO_TOKEN = (process.env.TURSO_AUTH_TOKEN || process.env.LIBSQL_AUTH_TOKEN || '').trim();

let isTursoActive = false;
let authClient;

if (TURSO_URL && TURSO_TOKEN) {
  try {
    authClient = createClient({
      url: TURSO_URL,
      authToken: TURSO_TOKEN,
    });
    isTursoActive = true;
    console.log(`[Database] ✓ Connected to persistent cloud database (Turso): ${TURSO_URL.replace(/:\/\/.*@/, '://***@')}`);
  } catch (err) {
    console.error('[Database] ✗ Failed to initialize Turso client, falling back to local SQLite:', err.message);
  }
}

if (!isTursoActive) {
  authClient = createClient({
    url: 'file:' + DB_FILE,
  });
  if (process.env.RENDER === 'true') {
    console.warn('\n[Database] ⚠️  RENDER DETECTED WITHOUT TURSO_DATABASE_URL!');
    console.warn('[Database] User accounts stored on ephemeral disk will reset on redeployment.');
    console.warn('[Database] To persist user accounts permanently across all redeploys, set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in Render environment variables.\n');
  } else {
    console.log(`[Database] Using local database file: ${DB_FILE}`);
  }
}

// Initialize tables on authClient asynchronously on startup
(async function initAuthDatabase() {
  try {
    await authClient.execute(`
      CREATE TABLE IF NOT EXISTS users (
        email TEXT PRIMARY KEY COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        window_start INTEGER NOT NULL,
        count_in_window INTEGER DEFAULT 0,
        total_extractions INTEGER DEFAULT 0,
        has_rated INTEGER DEFAULT 0
      );
    `);
    await authClient.execute(`
      CREATE TABLE IF NOT EXISTS anon_usage (
        ip TEXT PRIMARY KEY,
        count INTEGER DEFAULT 0,
        last_used_at INTEGER NOT NULL
      );
    `);
    await authClient.execute(`
      CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        description TEXT,
        timestamp TEXT NOT NULL,
        user_email TEXT,
        page TEXT
      );
    `);
    await authClient.execute(`
      CREATE TABLE IF NOT EXISTS ratings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stars INTEGER NOT NULL,
        feedback TEXT,
        user_email TEXT NOT NULL DEFAULT 'anonymous',
        timestamp TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    db.exec(`
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

    // If connected to external Turso and Turso users table is empty, auto-migrate existing local SQLite users
    if (isTursoActive) {
      const tursoUsers = await authClient.execute('SELECT COUNT(*) as count FROM users');
      const count = Number(tursoUsers.rows[0]?.count || 0);
      if (count === 0) {
        const localUsers = db.prepare('SELECT * FROM users').all();
        if (localUsers.length > 0) {
          console.log(`[Database] Migrating ${localUsers.length} local SQLite user(s) to persistent Turso cloud...`);
          for (const u of localUsers) {
            await authClient.execute({
              sql: `INSERT OR IGNORE INTO users (email, password_hash, created_at, window_start, count_in_window, total_extractions, has_rated) VALUES (?, ?, ?, ?, ?, ?, ?)`,
              args: [u.email, u.password_hash, u.created_at, u.window_start, u.count_in_window || 0, u.total_extractions || 0, u.has_rated || 0],
            });
          }
          console.log('[Database] ✓ Migration to Turso cloud complete!');
        }
      }
    }
  } catch (err) {
    console.error('[Database] Table initialization error:', err.message);
  }
})();

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

async function getAnonUsage(ip) {
  try {
    const res = await authClient.execute({
      sql: 'SELECT count FROM anon_usage WHERE ip = ?',
      args: [ip],
    });
    const count = (res.rows && res.rows[0]) ? Number(res.rows[0].count) : 0;
    return { ip, count, remaining: Math.max(0, ANON_LIMIT - count), limit: ANON_LIMIT };
  } catch (err) {
    return { ip, count: 0, remaining: ANON_LIMIT, limit: ANON_LIMIT };
  }
}

async function incAnonUsage(ip) {
  const now = Date.now();
  try {
    await authClient.execute({
      sql: `
        INSERT INTO anon_usage (ip, count, last_used_at)
        VALUES (?, 1, ?)
        ON CONFLICT(ip) DO UPDATE SET count = count + 1, last_used_at = ?
      `,
      args: [ip, now, now],
    });
  } catch (err) {
    console.error('[Database] incAnonUsage error:', err.message);
  }
  return getAnonUsage(ip);
}

async function getUser(email) {
  if (!email || typeof email !== 'string') return null;
  const clean = email.toLowerCase().trim();
  try {
    const res = await authClient.execute({
      sql: 'SELECT * FROM users WHERE LOWER(email) = LOWER(?)',
      args: [clean],
    });
    const row = res.rows && res.rows[0];
    if (!row) return null;
    return {
      email: String(row.email).toLowerCase().trim(),
      passwordHash: String(row.password_hash),
      createdAt: Number(row.created_at),
      windowStart: Number(row.window_start),
      countInWindow: Number(row.count_in_window || 0),
      totalExtractions: Number(row.total_extractions || 0),
      hasRated: Number(row.has_rated || 0),
    };
  } catch (err) {
    console.error(`[Database] getUser error for [${clean}]:`, err.message);
    return null;
  }
}

async function saveUser(user) {
  const cleanEmail = (user.email || '').toLowerCase().trim();
  try {
    await authClient.execute({
      sql: `
        INSERT INTO users (email, password_hash, created_at, window_start, count_in_window, total_extractions, has_rated)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(email) DO UPDATE SET
          password_hash = excluded.password_hash,
          created_at = excluded.created_at,
          window_start = excluded.window_start,
          count_in_window = excluded.count_in_window,
          total_extractions = excluded.total_extractions,
          has_rated = excluded.has_rated
      `,
      args: [
        cleanEmail,
        user.passwordHash,
        user.createdAt || Date.now(),
        user.windowStart || Date.now(),
        user.countInWindow || 0,
        user.totalExtractions || 0,
        user.hasRated || 0,
      ],
    });
  } catch (err) {
    console.error(`[Database] saveUser error for [${cleanEmail}]:`, err.message);
  }
}

async function refreshWindow(user) {
  const now = Date.now();
  if (!user.windowStart || now - user.windowStart > WINDOW_MS) {
    user.windowStart   = now;
    user.countInWindow = 0;
    await saveUser(user);
  }
}

function getRemaining(user) {
  return Math.max(0, AUTH_LIMIT - (user.countInWindow || 0));
}

/* ─── Extraction History Helpers (90-day retention, max 100 per user) ──────── */
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_HISTORY_PER_USER = 100;

const CANONICAL_LANG_NAMES = {
  python: 'Python',
  javascript: 'JavaScript',
  js: 'JavaScript',
  typescript: 'TypeScript',
  ts: 'TypeScript',
  html: 'HTML',
  xml: 'XML',
  css: 'CSS',
  scss: 'SCSS',
  sql: 'SQL',
  json: 'JSON',
  php: 'PHP',
  cpp: 'C++',
  'c++': 'C++',
  c: 'C',
  csharp: 'C#',
  'c#': 'C#',
  cs: 'C#',
  java: 'Java',
  kotlin: 'Kotlin',
  swift: 'Swift',
  rust: 'Rust',
  go: 'Go',
  golang: 'Go',
  ruby: 'Ruby',
  bash: 'Bash',
  sh: 'Bash',
  shell: 'Bash',
  zsh: 'Bash',
  r: 'R',
  dart: 'Dart',
  lua: 'Lua',
  yaml: 'YAML',
  yml: 'YAML',
  dockerfile: 'Dockerfile',
  markdown: 'Markdown',
  md: 'Markdown',
};

function formatLanguageName(lang) {
  if (!lang || typeof lang !== 'string') return 'Unknown';
  const clean = lang.trim().toLowerCase();
  if (['auto', 'plaintext', 'unknown', 'code', 'text'].includes(clean)) {
    return 'Unknown';
  }
  if (CANONICAL_LANG_NAMES[clean]) {
    return CANONICAL_LANG_NAMES[clean];
  }
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function generateStandardHistoryName(lang, timestamp, batchCount = null) {
  const d = new Date(timestamp || Date.now());
  const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

  if (batchCount && Number(batchCount) > 1) {
    return `Batch ${batchCount} images · ${dateStr}, ${timeStr}`;
  }

  const langName = formatLanguageName(lang);
  return `${langName} · ${dateStr}, ${timeStr}`;
}

// Legacy alias
const generateDefaultHistoryName = generateStandardHistoryName;

function cleanupExpiredHistory() {
  const now = Date.now();
  const res = db.prepare('DELETE FROM extraction_history WHERE expires_at <= ?').run(now);
  const count = res.changes || 0;
  if (count > 0) {
    console.log(`[History Cleanup] Deleted ${count} expired extraction history row(s) (90-day retention)`);
  }
  return count;
}

/* ─── One-time Startup Deduplication Cleanup ────────────────────────────── */
function cleanupDuplicateHistoryEntries() {
  try {
    const allRows = db.prepare(`
      SELECT id, user_email, custom_name, extracted_code, language, created_at
      FROM extraction_history
      ORDER BY LOWER(user_email), created_at ASC, id ASC
    `).all();

    const idsToDelete = new Set();
    const WINDOW_MS = 60 * 1000; // 60-second window per extraction

    for (let i = 0; i < allRows.length; i++) {
      const current = allRows[i];
      if (idsToDelete.has(current.id)) continue;

      for (let j = i + 1; j < allRows.length; j++) {
        const next = allRows[j];
        if (next.user_email.toLowerCase() !== current.user_email.toLowerCase()) break;
        if (Math.abs(next.created_at - current.created_at) > WINDOW_MS) break;

        const sameCode = (next.extracted_code.trim() === current.extracted_code.trim());
        const sameExtraction = sameCode || (
          Math.abs(next.created_at - current.created_at) <= 15000 &&
          (current.language === 'auto' || next.language === 'auto' || current.language === next.language)
        );

        if (sameExtraction) {
          if (current.language === 'auto' && next.language !== 'auto') {
            idsToDelete.add(current.id);
            break;
          } else {
            idsToDelete.add(next.id);
          }
        }
      }
    }

    // Deduplicate any exact timestamp collisions for same user
    const exactDupes = db.prepare(`
      SELECT id FROM extraction_history
      WHERE id NOT IN (
        SELECT MIN(id) FROM extraction_history
        GROUP BY LOWER(user_email), created_at
      )
    `).all();
    for (const r of exactDupes) {
      idsToDelete.add(r.id);
    }

    if (idsToDelete.size > 0) {
      const deleteStmt = db.prepare('DELETE FROM extraction_history WHERE id = ?');
      const deleteTx = db.transaction((ids) => {
        for (const id of ids) deleteStmt.run(id);
      });
      deleteTx(Array.from(idsToDelete));
      console.log(`[History Cleanup] Removed ${idsToDelete.size} duplicate history row(s) on startup`);
    } else {
      console.log('[History Cleanup] No duplicate history rows found');
    }
  } catch (err) {
    console.warn('[History Cleanup] Duplicate cleanup note:', err.message);
  }
}

/* ─── Syntax Analysis & Language Detection Engine ─────────────────────── */
function detectCodeLanguage(code, rawGemini = '') {
  if (!code || typeof code !== 'string') return 'plaintext';
  const clean = code.trim();
  if (!clean) return 'plaintext';

  // 1. If Gemini explicitly tagged language in markdown fence (e.g. ```python)
  if (rawGemini && typeof rawGemini === 'string') {
    const fenceMatch = rawGemini.match(/```([a-zA-Z0-9_+#-]+)/);
    if (fenceMatch) {
      const tag = fenceMatch[1].toLowerCase().trim();
      const FENCE_MAP = {
        py: 'python', python: 'python',
        js: 'javascript', javascript: 'javascript', jsx: 'javascript',
        ts: 'typescript', typescript: 'typescript', tsx: 'typescript',
        html: 'html', xml: 'xml',
        css: 'css', scss: 'scss', sass: 'scss',
        java: 'java',
        c: 'c', cpp: 'cpp', 'c++': 'cpp',
        cs: 'csharp', csharp: 'csharp', 'c#': 'csharp',
        php: 'php',
        rb: 'ruby', ruby: 'ruby',
        go: 'go', golang: 'go',
        rs: 'rust', rust: 'rust',
        sql: 'sql',
        sh: 'bash', bash: 'bash', zsh: 'bash', shell: 'bash',
        json: 'json', yml: 'yaml', yaml: 'yaml',
        kt: 'kotlin', kotlin: 'kotlin',
        swift: 'swift',
        dart: 'dart',
        r: 'r'
      };
      if (FENCE_MAP[tag]) {
        return FENCE_MAP[tag];
      }
    }
  }

  // 2. Syntax Analysis Priority 1: PYTHON
  // Check Python keywords, colons + indentation, and lack of PHP/C syntax
  const hasPhpTags = /<\?php|\b\$_GET\b|\b\$_POST\b|\b\$_SERVER\b|\b\$_SESSION\b|->|echo\s+\$/.test(clean);
  const hasPythonColonBlock = /(?:^|\n)\s*(?:def\s+\w+\s*\(|class\s+\w+.*:|if\s+.+:|elif\s+.+:|else\s*:|for\s+\w+(?:,\s*\w+)*\s+in\s+.+:|while\s+.+:|try\s*:|except(?:\s+[\w\s,]+)?(?:\s+as\s+\w+)?:|finally\s*:|with\s+.+\s+as\s+\w+:)\s*(?:\n\s+.*)/i.test(clean);
  const hasPythonKeywords = /\b(def\s+\w+\s*\(|import\s+[\w.]+|from\s+[\w.]+\s+import|elif\s+|self\b|__init__|__name__|__main__|lambda\s+\w+:|yield\b|pass\b|raise\s+\w+)/.test(clean);
  const hasPythonPrint = /\bprint\s*\(/.test(clean);
  const hasPythonTypes = /\b(None|True|False)\b/.test(clean);

  if (!hasPhpTags && (hasPythonColonBlock || hasPythonKeywords || (hasPythonPrint && hasPythonTypes) || (hasPythonPrint && !/[;{}]/.test(clean)))) {
    return 'python';
  }

  // 3. Syntax Analysis Priority 2: JAVASCRIPT / TYPESCRIPT
  const hasJsKeywords = /\b(const\s+\w+|let\s+\w+|var\s+\w+|function\s*\w*\(|console\.(log|warn|error|info)\(|export\s+(default|const|let)|import\s+.*\s+from\s+['"]|require\s*\(['"]|=>)\b/.test(clean) || /=>\s*[{(\n]/.test(clean);
  const hasTsKeywords = /\b(interface\s+\w+|type\s+\w+\s*=|:\s*(string|number|boolean|any|void)\b)/.test(clean);
  if (hasTsKeywords && hasJsKeywords) return 'typescript';
  if (hasJsKeywords) return 'javascript';

  // 4. Syntax Analysis Priority 3: HTML / XML
  if (/<!DOCTYPE\s+html/i.test(clean) || /<html[\s>]/i.test(clean) || (/<(div|span|p|a|ul|ol|li|table|form|button|input|header|footer|nav|section|article)[\s>]/i.test(clean) && /<\/\w+>/.test(clean))) {
    return 'html';
  }

  // 5. Syntax Analysis Priority 4: CSS / SCSS
  if (/[.#][\w-]+\s*\{[^}]*:(?!:)[^}]+\}/.test(clean) || /@(media|keyframes|import)\b/.test(clean) || (/\b(margin|padding|background|color|display|font-size|border-radius)\s*:\s*[^;]+;/i.test(clean) && !hasPythonColonBlock)) {
    return 'css';
  }

  // 6. Syntax Analysis Priority 5: JAVA
  if (/\b(public\s+class\s+\w+|public\s+static\s+void\s+main|System\.out\.print(ln)?\(|@Override\b)/.test(clean)) {
    return 'java';
  }

  // 7. C# / C++ / C
  if (/\b(using\s+System(\.\w+)*;|namespace\s+\w+|Console\.WriteLine\()/.test(clean)) {
    return 'csharp';
  }
  if (/#include\s*<[\w.]+>/.test(clean) || /\b(std::cout|std::cin|std::endl)\b/.test(clean)) {
    return 'cpp';
  }

  // 8. SQL
  if (/\b(SELECT\s+[\w*,\s]+\s+FROM\s+\w+|INSERT\s+INTO\s+\w+|UPDATE\s+\w+\s+SET|CREATE\s+TABLE\s+\w+|DELETE\s+FROM\s+\w+)\b/i.test(clean)) {
    return 'sql';
  }

  // 9. PHP (STRICT check — only if actual PHP markers exist)
  if (hasPhpTags || (/\$\w+\s*=/.test(clean) && /echo\b|function\b|return\b/.test(clean) && /[;{}]/.test(clean) && !hasPythonColonBlock)) {
    return 'php';
  }

  // 10. Shell / Bash
  if (/^#!\/(bin|usr)\/(bash|sh|zsh)/m.test(clean) || /\b(echo\s+['"].*['"]|chmod\s+[+0-9]|sudo\s+\w+|apt-get\s+|npm\s+(install|run)|git\s+(commit|push|pull|clone))\b/.test(clean)) {
    return 'bash';
  }

  return 'plaintext';
}

/* ─── Re-label History Languages Migration ───────────────────────────────── */
function relabelHistoryLanguages() {
  try {
    const rows = db.prepare('SELECT id, custom_name, extracted_code, language, created_at FROM extraction_history').all();
    let updatedCount = 0;
    const updateStmt = db.prepare('UPDATE extraction_history SET language = ?, custom_name = ? WHERE id = ?');

    for (const row of rows) {
      if (!row.extracted_code) continue;
      // If language was php, or auto, or unknown, or plaintext
      if (row.language === 'php' || row.language === 'auto' || row.language === 'unknown' || row.language === 'plaintext' || !row.language) {
        let newLang = 'Code';
        const langMatch = row.extracted_code.match(/^[ \t]*#[ \t]*LANGUAGE:[ \t]*([^\r\n]+)/im);
        if (langMatch) {
          const l = langMatch[1].trim().toLowerCase();
          if (l && !['unknown', 'auto', 'code', 'plaintext', 'none'].includes(l)) {
            newLang = formatLanguageName(l);
          }
        }
        const isBatch = row.custom_name && row.custom_name.startsWith('Batch ');
        let newName = row.custom_name;
        if (!isBatch && (!row.custom_name || row.custom_name.startsWith('PHP ·') || row.custom_name.startsWith('Code ·') || row.custom_name.startsWith('Unknown ·'))) {
          newName = generateStandardHistoryName(newLang, row.created_at);
        }
        updateStmt.run(newLang, newName, row.id);
        updatedCount++;
      }
    }
    if (updatedCount > 0) {
      console.log(`[Language Relabel] Reset ${updatedCount} legacy history entries to verified Gemini language / "Code"`);
    }
  } catch (err) {
    console.warn('[Language Relabel] Note:', err.message);
  }
}

// Run cleanups & migrations immediately on server start and once daily (every 24h)
cleanupExpiredHistory();
cleanupDuplicateHistoryEntries();
relabelHistoryLanguages();
setInterval(cleanupExpiredHistory, 24 * 60 * 60 * 1000);

// Add unique constraint on (user_email, created_at) in database
try {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_history_user_created_unique
    ON extraction_history(user_email, created_at);
  `);
} catch (err) {
  console.warn('[Database] Unique constraint note:', err.message);
}

function saveExtractionHistory(email, extractedCode, language = 'Code', customName = null, batchCount = null) {
  if (!email || !extractedCode || typeof extractedCode !== 'string') return null;
  const emailClean = email.toLowerCase().trim();
  const now = Date.now();
  const expiresAt = now + NINETY_DAYS_MS;

  // Language defaults strictly to "Code" if missing or generic
  let finalLang = (language && typeof language === 'string') ? language.trim() : 'Code';
  if (['auto', 'unknown', 'plaintext', 'none', ''].includes(finalLang.toLowerCase())) {
    finalLang = 'Code';
  } else {
    finalLang = formatLanguageName(finalLang);
  }

  // Deduplication check: if same user saved the exact same code in the last 10 seconds, do not insert duplicate
  const recentDuplicate = db.prepare(`
    SELECT id, custom_name, language, created_at, expires_at
    FROM extraction_history
    WHERE LOWER(user_email) = LOWER(?) AND extracted_code = ? AND created_at > ?
    ORDER BY created_at DESC LIMIT 1
  `).get(emailClean, extractedCode, now - 10000);

  if (recentDuplicate) {
    console.log(`[History] Duplicate save prevented for [${emailClean}] (matches entry #${recentDuplicate.id})`);
    return {
      id: recentDuplicate.id,
      user_email: emailClean,
      custom_name: recentDuplicate.custom_name,
      extracted_code: extractedCode,
      language: recentDuplicate.language,
      created_at: recentDuplicate.created_at,
      expires_at: recentDuplicate.expires_at,
      duplicate: true,
    };
  }

  const name = (customName && customName.trim())
    ? customName.trim()
    : generateStandardHistoryName(finalLang, now, batchCount);

  let info;
  try {
    info = db.prepare(`
      INSERT INTO extraction_history (user_email, custom_name, extracted_code, language, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(emailClean, name, extractedCode, language || 'auto', now, expiresAt);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      console.log(`[History] Database rejected duplicate save on UNIQUE constraint for [${emailClean}] at ${now}`);
      const existing = db.prepare(`
        SELECT id, custom_name, language, created_at, expires_at
        FROM extraction_history
        WHERE LOWER(user_email) = LOWER(?) AND created_at = ?
      `).get(emailClean, now);
      return existing || null;
    }
    throw err;
  }

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

  const insertId = Number(info.lastInsertRowid);
  console.log(`[History] History saved for [${emailClean}] (entry #${insertId})`);

  return {
    id: insertId,
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
  relabelHistoryLanguages();
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
app.get('/api/anon/status', async (req, res) => {
  const ip = getClientIp(req);
  res.json(await getAnonUsage(ip));
});

/* ─── POST /api/feedback ─────────────────────────────────────────────────── */
app.post('/api/feedback', authenticate, async (req, res) => {
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

    let newId;
    if (authClient) {
      const result = await authClient.execute({
        sql: 'INSERT INTO feedback (type, description, timestamp, user_email, page) VALUES (?, ?, ?, ?, ?)',
        args: [issueType, descClean, now, userEmail, pageClean]
      });
      newId = Number(result.lastInsertRowid || 0);
    } else {
      const stmt = db.prepare(`
        INSERT INTO feedback (type, description, timestamp, user_email, page)
        VALUES (?, ?, ?, ?, ?)
      `);
      const result = stmt.run(issueType, descClean, now, userEmail, pageClean);
      newId = Number(result.lastInsertRowid || 0);
    }

    console.log(`[Feedback] ✓ New report #${newId}: [${issueType}] by ${userEmail || 'Anonymous'} (page: ${pageClean})`);
    res.json({ ok: true, id: newId });
  } catch (err) {
    console.error('[Feedback] ✗ Critical error saving feedback report:', err.message, err.stack);
    res.status(500).json({ error: `Failed to save feedback report: ${err.message}` });
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
app.get('/api/admin/feedback', async (req, res) => {
  if (!verifyAdminAuth(req)) {
    return res.status(401).json({ error: 'Admin authentication required.' });
  }
  try {
    let rows = [];
    if (authClient) {
      const result = await authClient.execute('SELECT * FROM feedback ORDER BY id DESC');
      rows = result.rows || [];
    } else {
      rows = db.prepare('SELECT * FROM feedback ORDER BY id DESC').all();
    }
    res.json({ feedback: rows });
  } catch (err) {
    console.error('[Admin] Error fetching feedback:', err.message);
    res.status(500).json({ error: 'Failed to fetch feedback reports.' });
  }
});

/* ─── DELETE /api/admin/feedback/:id ─────────────────────────────────────── */
app.delete('/api/admin/feedback/:id', async (req, res) => {
  if (!verifyAdminAuth(req)) {
    return res.status(401).json({ error: 'Admin authentication required.' });
  }
  try {
    if (authClient) {
      await authClient.execute({ sql: 'DELETE FROM feedback WHERE id = ?', args: [req.params.id] });
    } else {
      db.prepare('DELETE FROM feedback WHERE id = ?').run(req.params.id);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── POST /api/admin/feedback/clear ─────────────────────────────────────── */
app.post('/api/admin/feedback/clear', async (req, res) => {
  if (!verifyAdminAuth(req)) {
    return res.status(401).json({ error: 'Admin authentication required.' });
  }
  try {
    if (authClient) {
      await authClient.execute('DELETE FROM feedback');
    } else {
      db.prepare('DELETE FROM feedback').run();
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

  const existing = await getUser(emailClean);
  if (existing)
    return res.status(409).json({ error: 'An account with this email already exists — sign in instead.' });

  const passwordHash = await bcrypt.hash(password, 12);
  const now = Date.now();

  const newUser = {
    email: emailClean,
    passwordHash,
    createdAt:        now,
    windowStart:      now,
    countInWindow:    0,
    totalExtractions: 0,
    hasRated:         0,
  };
  await saveUser(newUser);

  const token = jwt.sign({ email: emailClean }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
  console.log(`[Auth] Registered: ${emailClean} (storage: ${isTursoActive ? 'turso' : 'sqlite'})`);
  res.json({ token, email: emailClean, remaining: AUTH_LIMIT, limit: AUTH_LIMIT, isPersistent: isTursoActive });
});

/* ─── POST /api/auth/login ───────────────────────────────────────────────── */
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password)
    return res.status(400).json({ error: 'Email and password are required.' });

  const emailClean = (email || '').toLowerCase().trim();
  const user = await getUser(emailClean);

  console.log(`[Auth] Login attempt for [${emailClean}] — found: ${user ? 'yes' : 'no'} (storage: ${isTursoActive ? 'turso' : 'sqlite'})`);

  if (!user)
    return res.status(401).json({ error: 'No account found with this email.' });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid)
    return res.status(401).json({ error: 'Incorrect password. Please try again.' });

  await refreshWindow(user);
  await saveUser(user);

  const remaining = getRemaining(user);
  const token = jwt.sign({ email: emailClean }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
  console.log(`[Auth] Login: ${emailClean} — ${remaining} remaining today`);
  res.json({ token, email: emailClean, remaining, limit: AUTH_LIMIT,
             resetAt: user.windowStart + WINDOW_MS, isPersistent: isTursoActive });
});

/* ─── GET /api/auth/me ───────────────────────────────────────────────────── */
app.get('/api/auth/me', authenticate, async (req, res) => {
  if (!req.user)
    return res.status(401).json({ error: 'Please sign in to continue.' });

  const user = await getUser(req.user.email);
  if (!user)
    return res.status(404).json({ error: 'Account not found. Please sign in again.' });

  await refreshWindow(user);
  await saveUser(user);

  const remaining = getRemaining(user);
  res.json({
    email:        req.user.email,
    remaining,
    limit:        AUTH_LIMIT,
    resetAt:      user.windowStart + WINDOW_MS,
    isPersistent: isTursoActive,
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
  const { codeText, extractedCode, lang, language, customName, historyId, batchCount } = req.body || {};
  const code = extractedCode || codeText;
  const languageName = language || lang || 'auto';

  // If historyId is provided, update the existing entry's language and name
  if (historyId) {
    const existing = db.prepare('SELECT * FROM extraction_history WHERE id = ? AND LOWER(user_email) = LOWER(?)').get(historyId, req.user.email);
    if (existing) {
      const newName = customName || (existing.custom_name && !existing.custom_name.startsWith('Unknown ·') && !existing.custom_name.startsWith('Code ·')
        ? existing.custom_name
        : generateStandardHistoryName(languageName, existing.created_at, batchCount));
      db.prepare(`
        UPDATE extraction_history
        SET language = ?, custom_name = ?
        WHERE id = ? AND LOWER(user_email) = LOWER(?)
      `).run(languageName, newName, historyId, req.user.email);
      return res.json({ ok: true, id: historyId, customName: newName, language: languageName });
    }
  }

  if (!code) {
    return res.status(400).json({ error: 'No code content found to save.' });
  }

  const entry = saveExtractionHistory(req.user.email, code, languageName, customName, batchCount);
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

/* ─── OpenRouter error classifier ───────────────────────────────────────── */
function classifyOpenRouterError(status, data) {
  const msg    = data?.error?.message || data?.message || '';
  const reason = data?.error?.code || data?.error?.metadata?.provider_name || '';
  const detail = { status, msg, reason, raw: JSON.stringify(data?.error || data) };

  if (status === 401 || msg.toLowerCase().includes('user key') || msg.toLowerCase().includes('invalid api key'))
    return { ...detail, type: 'INVALID_KEY',
      friendly: 'Something went wrong on our end. Please try again shortly.' };
  if (status === 403)
    return { ...detail, type: 'ACCESS_DENIED',
      friendly: 'Something went wrong on our end. Please try again shortly.' };
  if (status === 429 || msg.toLowerCase().includes('rate limit'))
    return { ...detail, type: 'RATE_LIMIT',
      friendly: 'Our service is experiencing high demand right now. Please wait a few seconds and try again.' };
  if (status === 404 || msg.includes('not found') || msg.includes('not support'))
    return { ...detail, type: 'MODEL_NOT_FOUND', friendly: 'Extraction failed — our service is temporarily unavailable. Please try again in a moment.' };
  return { ...detail, type: 'API_ERROR', friendly: 'Extraction failed — our service is temporarily unavailable. Please try again in a moment.' };
}

const classifyGeminiError = classifyOpenRouterError;
const MODEL_TIMEOUT_MS = 15000; // 15 seconds timeout per model attempt

/* ─── OpenRouter Strategy ────────────────────────────────────────────────── */
async function tryOpenRouterExtraction(model, imageBase64, mimeType, timeoutMs = PER_MODEL_TIMEOUT_MS) {
  const apiKey = (process.env.OPENROUTER_API_KEY || '').trim();
  const res = await fetch(OPENROUTER_BASE, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://code-snapper.onrender.com',
      'X-Title': 'CodeSnapper'
    },
    body: JSON.stringify({
      model: model,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
          { type: 'text', text: EXTRACTION_PROMPT }
        ]
      }],
      max_tokens: 4000
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const data = await res.json().catch(() => ({}));
  const text = data?.choices?.[0]?.message?.content;
  return { ok: res.ok, text, status: res.status, data, endpoint: 'openrouter' };
}

// Legacy alias
const tryNativeEndpoint = async (model, _token, _isBearer, body, timeoutMs) => {
  // If called from test or warmup, extract image or ping
  const part = body?.contents?.[0]?.parts;
  const imgPart = part?.find(p => p.inline_data);
  const textPart = part?.find(p => p.text)?.text || '';
  if (imgPart) {
    return tryOpenRouterExtraction(model, imgPart.inline_data.data, imgPart.inline_data.mime_type, timeoutMs);
  }
  const apiKey = (process.env.OPENROUTER_API_KEY || '').trim();
  const res = await fetch(OPENROUTER_BASE, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://code-snapper.onrender.com',
      'X-Title': 'CodeSnapper'
    },
    body: JSON.stringify({
      model: model,
      messages: [{ role: 'user', content: textPart || 'ping' }],
      max_tokens: 10
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const data = await res.json().catch(() => ({}));
  const text = data?.choices?.[0]?.message?.content;
  return { res, ok: res.ok, text, status: res.status, data, endpoint: 'openrouter' };
};

/* ─── Gemini Response Parser (Language & Code Extraction) ─────────────────── */
function parseGeminiOutput(raw) {
  if (!raw || typeof raw !== 'string') return { code: '', language: 'Code', ambiguities: [], noCode: true };
  if (raw.includes('# NO_CODE_FOUND')) return { code: '', language: 'Code', ambiguities: [], noCode: true };

  let text = raw;
  let language = 'Code';

  // 1. Check for # LANGUAGE: <lang> line on line 1 or top
  const langMatch = text.match(/^[ \t]*#[ \t]*LANGUAGE:[ \t]*([^\r\n]+)/im);
  if (langMatch) {
    const rawLang = langMatch[1].trim().toLowerCase();
    if (rawLang && !['unknown', 'auto', 'code', 'plaintext', 'none'].includes(rawLang)) {
      language = formatLanguageName(rawLang);
    }
    // Remove the # LANGUAGE: line so the returned code is pure source code
    text = text.replace(/^[ \t]*#[ \t]*LANGUAGE:[ \t]*[^\r\n]*\r?\n?/im, '');
  } else {
    // 2. Check if LLM wrapped in markdown code fences with language identifier (e.g. ```python)
    const fenceMatch = text.match(/^```([a-zA-Z0-9_+#-]+)/m);
    if (fenceMatch) {
      const rawLang = fenceMatch[1].trim().toLowerCase();
      if (rawLang && !['unknown', 'auto', 'code', 'plaintext'].includes(rawLang)) {
        language = formatLanguageName(rawLang);
      }
    }
  }

  // Strip code fences
  text = text.replace(/^```[\w]*\n?/gm, '').replace(/^```\n?/gm, '');

  // Extract ambiguity notes if present
  const lines = text.split(/\r?\n/);
  const ambiguities = [];
  let ambigStartIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('# AMBIGUOUS:')) {
      if (ambigStartIdx === -1) ambigStartIdx = i;
      ambiguities.push(trimmed.replace(/^#\s*AMBIGUOUS:\s*/, ''));
    }
  }

  let code = ambigStartIdx > 0 ? lines.slice(0, ambigStartIdx).join('\n') : text;
  code = code.replace(/\n+$/, '');

  return { code, language: language || 'Code', ambiguities, noCode: !code.trim() };
}

/* ─── GET /warmup (Pre-warm OpenRouter connection & DNS cache) ─────────────── */
app.get('/warmup', async (_req, res) => {
  const start = Date.now();
  try {
    await getOpenRouterToken();
    const durationMs = Date.now() - start;
    return res.json({ status: 'warm', durationMs, isTurso: isTursoActive });
  } catch (err) {
    return res.json({ status: 'warmed_network', durationMs: Date.now() - start, note: err.message, isTurso: isTursoActive });
  }
});

/* ─── POST /api/extract ──────────────────────────────────────────────────── */
app.post('/api/extract', authenticate, async (req, res) => {
  const imageStartTime = Date.now();

  /* ── 1. Initial OpenRouter token verification ── */
  let initialCred;
  try {
    initialCred = await getOpenRouterToken();
  } catch (e) {
    const code = e.code || 'SERVER_CONFIG_ERROR';
    console.error('[CodeSnapper] ✗ Credential error:', e.message);
    return res.status(500).json({ error: 'Extraction failed — our service is temporarily unavailable. Please try again in a moment.', code });
  }

  /* ── 2. Auth-aware rate limiting (IP-based for anonymous, account-based for signed-in) ── */
  const clientIp = getClientIp(req);
  if (req.user) {
    const user = await getUser(req.user.email);
    if (!user) {
      return res.status(401).json({ error: 'Account not found. Please sign in again.', code: 'AUTH_REQUIRED' });
    }
    await refreshWindow(user);
    if (user.countInWindow >= AUTH_LIMIT) {
      const resetIn = Math.ceil((user.windowStart + WINDOW_MS - Date.now()) / 60000);
      return res.status(429).json({
        error:   `Daily limit reached (${AUTH_LIMIT}/day). Resets in ${resetIn} minute${resetIn !== 1 ? 's' : ''}.`,
        code:    'DAILY_LIMIT',
        resetAt: user.windowStart + WINDOW_MS,
      });
    }
  } else {
    // Anonymous users: server-side IP tracking
    const anonUsage = await getAnonUsage(clientIp);
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
  console.log(`\n[CodeSnapper] Extract ← ${userLabel} [cred: ${initialCred.mode}]`);

  /* ── 4. Try strategies across OpenRouter models ── */
  let hardAuthError = null;
  let rateLimitError = null;
  let totalTimeoutExceeded = false;
  let modelIndex = 0;

  for (const model of GEMINI_MODELS) {
    // Add pause with exponential backoff before fallback attempts (2000ms for 1st fallback, 4000ms for 2nd)
    if (modelIndex > 0) {
      const pauseMs = 2000 * Math.pow(2, modelIndex - 1);
      console.log(`[RateLimit] Switching model "${GEMINI_MODELS[modelIndex - 1]}" — waiting ${pauseMs / 1000}s before fallback to "${model}"…`);
      await new Promise(r => setTimeout(r, pauseMs));
    }
    modelIndex++;

    const elapsedBeforeModel = Date.now() - imageStartTime;
    if (elapsedBeforeModel >= MAX_IMAGE_TOTAL_TIMEOUT_MS) {
      console.warn(`[CodeSnapper] ⏱ Image reached 22s total limit (${elapsedBeforeModel}ms). Skipping further model attempts.`);
      totalTimeoutExceeded = true;
      break;
    }

    const currentAttemptTimeoutMs = Math.min(PER_MODEL_TIMEOUT_MS, MAX_IMAGE_TOTAL_TIMEOUT_MS - elapsedBeforeModel);

    try {
      console.log(`[CodeSnapper]   openrouter/${model} (timeout: ${currentAttemptTimeoutMs}ms, payload: ~${Math.round((imageData.length * 3 / 4) / 1024)} KB)…`);
      const { ok, text, status, data, endpoint } = await tryOpenRouterExtraction(model, imageData, mimeType, currentAttemptTimeoutMs);

      if (ok && text) {
        /* ── Parse language & clean code directly from LLM response ── */
        const parsed = parseGeminiOutput(text);

        /* ── Record API success and timing ── */
        const totalDurationMs = Date.now() - imageStartTime;
        _lastSuccessfulApiCall = new Date().toISOString();
        _totalSuccessfulCalls++;
        console.log(`[CodeSnapper] ✓ Image extraction completed in ${totalDurationMs}ms (${(totalDurationMs / 1000).toFixed(2)}s) [${endpoint}/${model}] | Language: "${parsed.language}" | Code length: ${parsed.code.length} chars`);

        /* ── Increment usage counter ── */
        let remaining = null;
        let shouldPromptRating = false;
        let totalExtractions = 0;
        if (req.user) {
          const user = await getUser(req.user.email);
          if (user) {
            await refreshWindow(user);
            user.countInWindow = (user.countInWindow || 0) + 1;
            user.totalExtractions = (user.totalExtractions || 0) + 1;
            await saveUser(user);
            remaining = Math.max(0, AUTH_LIMIT - user.countInWindow);
            totalExtractions = user.totalExtractions;
            if (totalExtractions === 30 && !user.hasRated) {
              shouldPromptRating = true;
            }
          }
          return res.json({ result: parsed.code, language: parsed.language, ambiguities: parsed.ambiguities, raw: text, model, endpoint, remaining, durationMs: totalDurationMs, shouldPromptRating, totalExtractions });
        } else {
          const newAnon = await incAnonUsage(clientIp);
          remaining = newAnon.remaining;
          return res.json({ result: parsed.code, language: parsed.language, ambiguities: parsed.ambiguities, raw: text, model, endpoint, remaining, durationMs: totalDurationMs });
        }
      }

      const err = classifyOpenRouterError(status, data);
      console.error(`[CodeSnapper] ✗ Attempt failed: model="${model}" endpoint="${endpoint}" | HTTP ${status} | [${err.type}] ${err.msg} | Response: ${JSON.stringify(data?.error || data)}`);

      if (err.type === 'RATE_LIMIT' || status === 429) {
        console.warn(`[RateLimit] Quota exhausted on model ${model} — waiting before fallback`);
        rateLimitError = err;
        continue;
      }

      if (['INVALID_KEY', 'ACCESS_DENIED'].includes(err.type) || status === 401 || status === 403) {
        hardAuthError = err;
        break;
      }

    } catch (networkErr) {
      const attemptDuration = Date.now() - imageStartTime;
      if (networkErr.name === 'AbortError' || networkErr.name === 'TimeoutError') {
        console.warn(`[CodeSnapper] ⏱ Timeout (${currentAttemptTimeoutMs}ms) on model="${model}" endpoint="openrouter" after ${attemptDuration}ms. Failing over to next model immediately…`);
      } else {
        console.error(`[CodeSnapper] ✗ Network error on model="${model}" endpoint="openrouter":`, networkErr.message, networkErr.stack || '');
      }
    }
    if (hardAuthError || totalTimeoutExceeded) break;
  }

  if (totalTimeoutExceeded) {
    console.error(`[CodeSnapper] ✗ Image extraction timed out: exceeded total timeout of 22s (${Date.now() - imageStartTime}ms) across attempted models: ${GEMINI_MODELS.join(', ')}`);
    return res.status(504).json({
      error: 'Extraction failed — please try again',
      code: 'IMAGE_TIMEOUT',
    });
  }

  if (hardAuthError) {
    console.error('\n[CodeSnapper] ══ AUTH FAILURE ═══════════════════');
    console.error(`  ${hardAuthError.type}: ${hardAuthError.msg}`);
    console.error('  Check your environment variables.\n');
    return res.status(401).json({ error: 'Extraction failed — please try again', code: 'INVALID_API_KEY' });
  }

  if (rateLimitError) {
    return res.status(429).json({
      error: 'Extraction failed — please try again',
      code:  'RATE_LIMIT',
    });
  }

  console.error(`[CodeSnapper] ✗ All models failed for image! Attempted models: ${GEMINI_MODELS.join(' → ')} | Total elapsed: ${Date.now() - imageStartTime}ms`);
  return res.status(502).json({
    error: 'Extraction failed — please try again',
    code:  'ALL_MODELS_FAILED',
  });
});

/* ─── Health check endpoint (/health & /api/health) ───────────────────────── */
app.get(['/health', '/api/health'], (_req, res) => {
  const apiKey = (process.env.OPENROUTER_API_KEY || '').trim();
  const isAuthOk = !!apiKey && apiKey !== 'your_openrouter_api_key_here';
  res.json({
    auth: isAuthOk ? 'ok' : 'failed',
    method: 'openrouter',
    database: isTursoActive ? 'turso-persistent' : 'sqlite-local',
    isPersistent: isTursoActive,
    lastSuccess: _lastSuccessfulApiCall,
    totalSuccess: _totalSuccessfulCalls,
    credentialPrefix: apiKey ? `${apiKey.slice(0, 10)}...` : 'none',
    models: GEMINI_MODELS,
    perModelTimeoutMs: PER_MODEL_TIMEOUT_MS,
    maxImageTotalTimeoutMs: MAX_IMAGE_TOTAL_TIMEOUT_MS,
    serverTime: new Date().toISOString(),
    status: isAuthOk ? 'ok' : 'error',
    error: isAuthOk ? null : 'OPENROUTER_API_KEY not configured'
  });
});

/* ─── Direct live OpenRouter test endpoint ────────────────────────────────── */
app.get(['/api/test-openrouter', '/api/test-gemini'], async (_req, res) => {
  const log = [];
  const start = Date.now();
  try {
    const cred = await getOpenRouterToken();
    const apiKey = cred.token;
    log.push(`Cred: mode=openrouter, format=${cred.format}, tokenPrefix=${apiKey.slice(0, 10)}...`);
    log.push(`Endpoint: ${OPENROUTER_BASE}`);

    const sample1x1Png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const r1 = await tryOpenRouterExtraction(GEMINI_MODELS[0], sample1x1Png, 'image/png', 8000);
    log.push(`Attempt 1 (${GEMINI_MODELS[0]} via OpenRouter): status=${r1.status}, text=${(r1.text || '').slice(0, 100)}, data=${JSON.stringify(r1.data).slice(0, 250)}`);

    res.json({ ok: r1.ok, status: r1.status, durationMs: Date.now() - start, log, data: r1.data });
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

  const apiKey = (process.env.OPENROUTER_API_KEY || '').trim();

  // If no OPENROUTER_API_KEY exists → crash immediately on startup
  if (!apiKey || apiKey === 'your_openrouter_api_key_here') {
    console.error('\n❌ CRITICAL STARTUP ERROR:');
    console.error('NO OPENROUTER_API_KEY FOUND — set OPENROUTER_API_KEY in environment variables.');
    console.error('Shutting down server immediately.\n');
    process.exit(1);
  }

  const prefix = apiKey.slice(0, 10);
  console.log(`[Auth] Using OPENROUTER_API_KEY (${prefix}…)`);
  console.log('─────────────────────────────────────────────────────────────');
  console.log(`[Auth] Status:            OK`);
  console.log(`[Auth] Active Method:     openrouter (Bearer)`);
  console.log(`[Auth] Loaded Credential: ${prefix}...`);
  console.log(`[Provider] Endpoint:      openrouter.ai/api/v1/chat/completions`);
  console.log(`[Provider] Models:        ${GEMINI_MODELS.join(' → ')}`);
  console.log('─────────────────────────────────────────────────────────────');

  // Startup test call to verify OpenRouter endpoint connectivity
  try {
    const testModel = GEMINI_MODELS[0];
    console.log(`[OpenRouter] Performing startup connection test to openrouter.ai (${testModel})…`);
    const sample1x1Png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const testRes = await tryOpenRouterExtraction(testModel, sample1x1Png, 'image/png', 8000);
    if (testRes.ok) {
      _lastSuccessfulApiCall = new Date().toISOString();
      _totalSuccessfulCalls++;
      console.log(`[OpenRouter] ✓ Startup connection test SUCCESSFUL (HTTP ${testRes.status})`);
    } else {
      console.warn(`[OpenRouter] ⚠ Startup connection test returned HTTP ${testRes.status}:`, JSON.stringify(testRes.data?.error || testRes.data));
    }
  } catch (testErr) {
    console.warn(`[OpenRouter] ⚠ Startup connection test skipped or failed:`, testErr.message);
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
