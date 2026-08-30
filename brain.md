# CodeSnapper — Brain.md (Source of Truth)

## Core App State Machine
Three mutually exclusive states — only one visible at a time:
- **UPLOAD**: show upload zone only (`#hero-panel`)
- **LOADING**: show spinner only, no text about retries or attempts ever shown to user (`#processing-panel`)
- **RESULT**: show extracted code only (`#result-panel`)

State transitions use triple-layer hide (`class="hidden"`, attribute `hidden="true"`, and inline `style.display = 'none'`) to guarantee complete visual isolation across all browsers and devices.

## Extraction Flow
1. User uploads image → state: **LOADING**
2. Client sends image to `POST /api/extract`
3. Server tries `gemini-3.5-flash-lite` first (10s timeout)
4. If fails → 500ms delay → try `gemini-3.5-flash` (10s timeout)
5. If both fail → return error to client
6. Client receives result → state: **RESULT**
7. On ANY failure after all retries: show friendly error, return to **UPLOAD** state
- **RULE**: Never show "Retrying", "attempt X of Y", or any model names to users.
- **RULE**: Error popup must NEVER auto-show on page refresh — only after a real failed extraction.

## API Credentials
- **Priority 1**: `GOOGLE_SERVICE_ACCOUNT_JSON` → service account authenticated via `google-auth-library`
  - Auto-refreshes token every 45 minutes
- **Priority 2**: `GEMINI_API_KEY` → static key passed via `?key=` query param
- **Current working models**: `gemini-3.5-flash-lite` → `gemini-3.5-flash`
- **Timeouts**:
  - Per-model timeout: `10000ms` (10 seconds)
  - Server total maximum timeout: `22000ms` (22 seconds)
  - Client fetch timeout: `30000ms` (30 seconds)

## Rate Limits
- **Anonymous**: 25 total extractions tracked server-side by IP (NOT localStorage)
- **Signed-in**: 50 extractions per rolling 24-hour window tracked server-side
- **Counter display**: shows `X/25` for anonymous, `X/50` for signed-in
- **Progress bar**:
  - Green: under 50%
  - Yellow: 50%–80%
  - Red: 80%+
- **On limit reached — anonymous**: show sign-in prompt modal (`#auth-modal`)
- **On limit reached — signed-in**: show "Resets in X hours Y minutes" countdown

## Database
- **Turso** (persistent cloud SQLite) when `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` are present in environment variables.
- Falls back to local SQLite (`codesnapper.db`) only if Turso credentials are missing.
- **Tables**: `users`, `anon_usage`, `extraction_history`, `feedback`, `ratings`
- **Case-Insensitive Auth**: Emails are always stored and queried in lowercase (`email.trim().toLowerCase()`).

## Extraction History (Signed-In Users Only)
- Saves after every successful extraction — **EXACTLY ONCE** per extraction upon confirmed success.
- **Auto-name format**: `"[Language] · [Date] [Time in user's local timezone]"`
- **Timezones**: Timestamps are stored in UTC, and displayed in user's browser timezone via JavaScript's `toLocaleString()` with `Intl.DateTimeFormat().resolvedOptions().timeZone`.
- **Max capacity**: 100 entries per user — oldest deleted when limit is exceeded.
- **Retention**: Auto-delete entries older than 90 days (`expires_at <= now`).
- **Renaming**: Users can rename entries inline with dedicated Save / Cancel buttons placed directly below the input (never overlapping).

## Error Handling Rules
- **NEVER** show technical terms to users: no "Gemini", "API", "model", "token", "credentials", "auth".
- **NEVER** show error popup on page refresh or page load — only after a real user action fails.
- **NEVER** show retry attempt count or "Retrying" text to users.
- **ALL** technical details (HTTP status codes, model failure types, stack traces) go to server console logs only.
- **Friendly error messages only**: `"Extraction failed — please try again"` with a single `"Try Again"` action button.

## Features Checklist
- **Upload**: File picker + drag-and-drop + `Ctrl+V` paste + mobile camera capture.
- **Camera**: `capture="environment"` for mobile rear camera, separate file input from standard upload.
- **Batch Processing**: Up to 5 images (anonymous) or 10 images (signed-in), auto-crop only, sequential processing with pacing.
- **Manual Crop**: Simple drag-to-select viewfinder, no pan/zoom clutter.
- **Auto Crop**: Fully automatic canvas-based border detection, 0 user interaction required.
- **History Panel**: Signed-in only, slide-over drawer accessible from header navbar.
- **Report an Issue**: Footer link and modal, saves to `feedback` table, admin views at `/admin/feedback`.
- **Rate Us**: Shows after 30th cumulative extraction, one-time only, saves to `ratings` table.
- **Warmup**: `GET /warmup` endpoint exists for background priming every 30s, with **NO** artificial pre-call delay before user extractions.
- **Health**: `GET /health` returns auth status, active model chain, db type, and server timestamps.

## What Must Never Change Without Updating This File
- State machine transition logic (`showPanel`)
- Model fallback chain order (`gemini-3.5-flash-lite` → `gemini-3.5-flash`)
- Timeout values (`10s` per model, `22s` server max, `30s` client fetch)
- Error message wording (clean, non-technical, single "Try Again" CTA)
- Database table structure and case-insensitive email matching
