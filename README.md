# CodeSnap 🔍

> **Extract clean, copy-ready code from any screenshot — powered by Gemini Vision AI**

[![Live Demo](https://img.shields.io/badge/Live%20Demo-code--snapper.onrender.com-blue?style=for-the-badge)](https://code-snapper.onrender.com)
[![Node.js](https://img.shields.io/badge/Node.js-v24-green?style=for-the-badge&logo=node.js)](https://nodejs.org)
[![Gemini Vision](https://img.shields.io/badge/Powered%20by-Gemini%20Vision-orange?style=for-the-badge&logo=google)](https://ai.google.dev)

---

## What is CodeSnap?

CodeSnap is a premium, dark-themed web app that lets you upload or paste a screenshot of code and instantly get back a clean, copy-ready version — with exact indentation, syntax highlighting, and every special character preserved (colons, brackets, quotes, all of it).

No more manually retyping code from tutorials, textbooks, or someone else's screen.

---

## Features

- 📸 **Upload, paste (Ctrl+V), or drag-and-drop** any code screenshot
- ✂️ **Auto Crop** — AI detects the code block boundary automatically with editable preview
- 🔍 **Manual Crop** — drag-to-select with zoom (10%–1000%) and pan controls for precision
- 🤖 **Gemini Vision extraction** — not traditional OCR; preserves indentation, whitespace, and special characters accurately
- 🎨 **Syntax highlighting** — auto-detects Python, JavaScript, HTML, CSS, Java, C++, and more
- 📋 **One-click Copy Code** — copies raw code only, no markdown or commentary
- ⚠️ **Confidence flagging** — highlights specific characters the AI was uncertain about
- 🔐 **Email auth** — sign up with email/password for extended daily limits
- 🛡️ **Privacy first** — images are never stored; proxied to Gemini and discarded immediately

---

## Usage Limits

| User type | Limit |
|---|---|
| Anonymous | 25 free extractions (tracked server-side by IP) |
| Signed-in | 50 extractions per rolling 24-hour window |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | HTML, CSS, JavaScript, Highlight.js |
| Backend | Node.js, Express.js |
| Database | SQLite (via better-sqlite3) |
| AI Vision | Google Gemini Vision API |
| Auth | bcrypt (12 rounds) + custom email/password |
| Package manager | pnpm |
| Hosting | Render |

---

## Local Development

### Prerequisites
- Node.js v22+
- pnpm (`corepack enable` then `corepack prepare pnpm@latest --activate`)
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/app/apikey)

### Setup

```bash
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
```

Then open [http://localhost:3000](http://localhost:3000) in your browser.

### Environment Variables

```env
GEMINI_API_KEY=your_key_here
```

> ⚠️ Never commit your `.env` file. It is listed in `.gitignore`.

---

## Security

- Passwords hashed with **bcrypt** (cost factor 12) — zero plaintext storage
- API key lives server-side only — users never see or touch it
- `.env` and `*.db` files are gitignored — no secrets in the repo
- Images discarded from memory immediately after extraction
- Anonymous rate limiting enforced server-side by IP (not bypassable via localStorage)

---

## How It Works

```
User uploads screenshot
        ↓
Auto Crop (AI boundary detection) or Manual Crop (zoom/pan selector)
        ↓
Cropped image sent to backend server
        ↓
Server proxies image to Gemini Vision API with strict extraction prompt
        ↓
Gemini returns exact code preserving all indentation, whitespace, characters
        ↓
Syntax highlighted, copy-ready code displayed to user
        ↓
Image discarded — nothing stored
```

---

## Roadmap

- [ ] Extraction history for signed-in users
- [ ] Batch image upload (multiple screenshots at once)
- [ ] Shareable result links (text only, auto-expiring)
- [ ] Custom domain

---

## Authors

Built by **Mubashir Shaikh** with **Claude (Anthropic)**

---

## License

This project is for personal/educational use. All rights reserved © 2026 Mubashir Shaikh.

---

> 💡 **Tip:** CodeSnap makes grabbing code from a screenshot fast — but speed isn't the same as understanding. Before you copy-paste, take a moment to actually read through the code: know what each part does, why it's structured that way, and how it fits your own project.
