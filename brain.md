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
3. Server tries `google/gemini-2.5-flash-lite` first (10s timeout) via OpenRouter API
4. If fails → exponential backoff delay → try `google/gemini-2.5-flash` (10s timeout)
5. If fails → try backup `meta-llama/llama-3.2-11b-vision-instruct:free`
6. If all fail → return error to client
7. Client receives result → state: **RESULT**
8. On ANY failure after all retries: show friendly error, return to **UPLOAD** state
- **RULE**: Never show "Retrying", "attempt X of Y", or any model names to users.
- **RULE**: Error popup must NEVER auto-show on page refresh — only after a real failed extraction.

## API Credentials & Endpoint
- Extraction uses OpenRouter API (openrouter.ai) with permanent sk-or- key. Models: google/gemini-2.5-flash-lite → google/gemini-2.5-flash → llama-3.2-vision:free. Key never expires.
- **Backend Endpoint**: `https://openrouter.ai/api/v1/chat/completions`
- **Auth Method**: Bearer token via `Authorization: Bearer ${process.env.OPENROUTER_API_KEY}`
- **Database Auth**: `GOOGLE_SERVICE_ACCOUNT_JSON` is reserved for Turso database / backend storage auth only.
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

## Counter Display Rules
- On page load: check `GET /api/auth/me` first
  - 401 = anonymous → fetch `GET /api/anon/status` → show `X/25`
  - 200 = signed in → fetch `GET /api/user/usage` → show `X/50`
- Update counter immediately after every successful extraction (no refresh needed)
- Never show 50 limit to anonymous user
- Progress bar: green <50%, yellow 50-80%, red 80%+

## Camera Lens Feature
- **Mobile**: uses native camera via `<input type="file" accept="image/*" capture="environment">` — NO custom viewfinder on mobile
- **Desktop**: uses `getUserMedia` custom viewfinder
- **Multi-capture flow**:
  1. User captures photo → review screen shows (Retake / + Add Photo / Done)
  2. "Add Photo" re-triggers native camera input, APPENDS to existing captures array — never replaces
  3. Thumbnail strip shows all captured photos with individual delete (×) buttons
  4. "Done" sends all captured photos to batch extraction pipeline
- **Limits**: anonymous = 5 captures, signed-in = 10 captures
- **Filenames**: "Camera Photo", "Camera Photo 2", etc. — never timestamps or random numbers
- **Blur detection**: client-side Laplacian variance check before sending — threshold ~50-100
  - If blurry (< 50): show "Photo looks blurry — please retake for better accuracy" with Retake button — never auto-send blurry image
  - If borderline (50–100): show "Photo may be blurry — results might be less accurate" with Retake or Use Anyway options

## Camera Multi-Capture Bug (FIXED — do not reintroduce)
- **Bug**: each new capture was replacing previous capture instead of appending
- **Fix**: captures stored in persistent array `[]` — Add Photo PUSHES to array, never replaces it
- **Fix**: check extraction limit BEFORE starting capture session and on Done click:
  - If user has 0 extractions remaining when camera opens or when Done is clicked:
    - Do NOT start extraction at all
    - Show sign-in prompt immediately: "You've used all 25 free extractions"
    - Stop execution
  - If user has X extractions remaining (where X < captured photos count):
    - Warn: "You have X extractions remaining — only first X photos will be extracted"
    - Slice captures array to first X items (`captures.slice(0, remaining)`)
    - Process sliced array into batch results
  - If user has >= captured photos count:
    - Extract all photos normally

## Batch Processing
- **Max limit**: 5 images anonymous, 10 signed-in (applies to both file upload AND camera captures)
- Each image = 1 extraction from daily limit
- **Processing**: sequential, 500ms delay between images, auto-crop only
- **Filenames shown in UI**: original filename for uploads, "Camera Photo X" for camera captures
- **Results**: tabbed (Image 1, Image 2...), each tab has own Copy button + Copy All button

## Extraction History (signed-in only)
- Saves **EXACTLY ONCE** per extraction after confirmed success
- **Auto-name format**: `"[Language] · [Date] [Time in user's local browser timezone]"`
- **Timestamps**: stored in UTC, displayed in user's local timezone via `toLocaleString()` with `Intl.DateTimeFormat().resolvedOptions().timeZone`
- **Capacity**: Max 100 entries per user, FIFO when exceeded, auto-delete after 90 days
- **Rename**: inline input field, Save/Cancel BELOW input (never overlapping)

## Report an Issue
- Footer link and results page button both call `openFeedbackModal()` directly — not a hash anchor
- Modal closes on: X button, Cancel button, backdrop click
- On close: reset form, clear textarea, hide error message, reset dropdown
- Submits to `POST /api/feedback` → saved to `feedback` SQLite table
- Admin views at `/admin/feedback` (password protected via `ADMIN_PASSWORD` env var)

## Database
- **Turso** (persistent cloud SQLite) when `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` are present in environment variables.
- Falls back to local SQLite (`codesnapper.db`) only if Turso credentials are missing.
- **Tables**: `users`, `anon_usage`, `extraction_history`, `feedback`, `ratings`
- **Case-Insensitive Auth**: Emails are always stored and queried in lowercase (`email.trim().toLowerCase()`).

## Error Handling Rules
- **NEVER** show technical terms to users: no "Gemini", "API", "model", "token", "credentials", "auth".
- **NEVER** show error popup on page refresh or page load — only after a real user action fails.
- **NEVER** show retry attempt count or "Retrying" text to users.
- **ALL** technical details (HTTP status codes, model failure types, stack traces) go to server console logs only.
- **Friendly error messages only**: `"Extraction failed — please try again"` with a single `"Try Again"` action button.

## What Must Never Change Without Updating This File
- State machine transition logic (`showPanel`)
- Model fallback chain order (`google/gemini-2.5-flash-lite` → `google/gemini-2.5-flash` → `meta-llama/llama-3.2-11b-vision-instruct:free`)
- Timeout values (`10s` per model, `22s` server max, `30s` client fetch)
- Error message wording (clean, non-technical, single "Try Again" CTA)
- Database table structure and case-insensitive email matching
