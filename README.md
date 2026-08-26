CodeSnapper 🔍

Extract clean, copy-ready code from any screenshot — powered by Gemini Vision AI

Show Image
Show Image
Show Image

What is CodeSnapper?

CodeSnapper is a premium, dark-themed web app that lets you upload, paste, photograph, or batch-process screenshots of code and instantly get back clean, copy-ready source — with exact indentation, syntax highlighting, and every special character preserved.

No more manually retyping code from tutorials, textbooks, whiteboards, or someone else's screen.

Features

Input methods:

📸 Upload — file picker, single or multiple images
📋 Paste — Ctrl+V / Cmd+V directly from clipboard
🖱️ Drag & drop — drop images anywhere on the upload zone
📷 Use Camera — point your phone at a whiteboard, projector screen, or printed page and capture code live (rear camera on mobile, webcam on desktop)

Crop modes:

✂️ Auto Crop — AI detects the code block boundary automatically and extracts with zero clicks
🔍 Manual Crop — simple drag-to-select crop tool, touch-friendly on mobile

Extraction:

🤖 Gemini Vision AI — not traditional OCR; preserves exact indentation, whitespace, and every special character
🎨 Syntax highlighting — auto-detects Python, JavaScript, HTML, CSS, Java, C++, and more
📋 One-click Copy Code — copies raw code only, nothing else
⚠️ Confidence flagging — highlights specific characters the AI was uncertain about

Batch processing:

🗂️ Batch upload — process up to 5 images at once (anonymous) or 10 images (signed in)
Sequential processing with per-image progress tracking
Tabbed results — Image 1, Image 2... each with its own Copy button
Copy All — concatenates all results in order with separator comments
Graceful per-image error handling — one failure doesn't stop the rest

Auth & limits:

25 free extractions for anonymous users (tracked server-side by IP)
Email sign-up for 50 extractions per rolling 24-hour window
Passwords hashed with bcrypt (12 rounds)

Privacy & security:

🔒 Images never stored — discarded from memory immediately after extraction
API key lives server-side only — users never see or touch it
Automatic token refresh — credentials refresh in the background, no manual key updates needed
Usage Limits
User type	Limit
Anonymous	25 free extractions (server-side IP tracking)
Signed-in	50 extractions per rolling 24-hour window
Batch (anonymous)	Up to 5 images per batch
Batch (signed-in)	Up to 10 images per batch
Tech Stack
Layer	Technology
Frontend	HTML, CSS, JavaScript, Highlight.js
Backend	Node.js, Express.js
Database	SQLite (via better-sqlite3)
AI Vision	Google Gemini Vision API
Auth	bcrypt (12 rounds) + custom email/password
Token refresh	google-auth-library (automatic background refresh)
Package manager	pnpm
Hosting	Render
Uptime monitoring	UptimeRobot (prevents cold starts)
Local Development
Prerequisites
Node.js v22+
pnpm (corepack enable then corepack prepare pnpm@latest --activate)
A Gemini API key from Google AI Studio
Setup
bash
# Clone the repo
git clone https://github.com/skullmubashir5656-bot/Code-Snapper.git
cd Code-Snapper

# Install dependencies
pnpm install

# Create your environment file
cp .env.example .env
# Add your Gemini API key to .env

# Start the server
pnpm start

Then open http://localhost:3000 in your browser.

Environment Variables
env
GEMINI_API_KEY=your_key_here
ADMIN_PASSWORD=your_admin_password_here

⚠️ Never commit your .env file. It is listed in .gitignore.

Admin Panel

View submitted feedback and bug reports at:

http://localhost:3000/admin/feedback

Password protected via ADMIN_PASSWORD in .env.

Security
Passwords hashed with bcrypt (cost factor 12) — zero plaintext storage
API key lives server-side only — users never see or touch it
Automatic credential refresh via google-auth-library — no manual token updates
.env and *.db files are gitignored — no secrets in the repo
Images discarded from memory immediately after extraction
Anonymous rate limiting enforced server-side by IP
How It Works
User uploads / pastes / drags / captures via camera
              ↓
   Single image or batch selection
              ↓
Auto Crop (zero clicks) or Manual Crop (drag to select)
              ↓
   Cropped image(s) sent to backend server
              ↓
Server proxies to Gemini Vision API with strict extraction prompt
              ↓
Gemini returns exact code — indentation, whitespace, all characters
              ↓
Syntax highlighted, copy-ready code displayed per image
              ↓
   Images discarded — nothing stored
Roadmap
 Single image extraction
 Auto Crop + Manual Crop
 Batch upload (up to 10 images)
 Camera / Lens capture
 Email auth + rate limiting
 Built-in feedback/bug report system
 Admin panel for feedback review
 Extraction history for signed-in users
 Shareable result links (text only, auto-expiring)
 Custom domain
Authors

Built by Mubashir Shaikh with Claude (Anthropic)

License

This project is for personal/educational use. All rights reserved © 2026 Mubashir Shaikh.

💡 Tip: CodeSnapper saves you retyping, not learning. Understand the code before you use it — don't just copy-paste blind.
