# CodeSnapper 🔍 — Extract Code from Screenshots with AI

> **Turn any code screenshot into clean, copy-ready source code — instantly, with Gemini Vision AI.**

CodeSnapper is a free online tool to extract code from images and screenshots. Upload a photo of code from a tutorial, textbook, whiteboard, or another screen, and get back perfectly formatted, syntax-highlighted, copy-paste-ready code in seconds — no manual retyping required.

[![Live Demo](https://img.shields.io/badge/Live%20Demo-code--snapper.onrender.com-blue?style=for-the-badge)](https://code-snapper.onrender.com)
[![Node.js](https://img.shields.io/badge/Node.js-v24-green?style=for-the-badge&logo=node.js)](https://nodejs.org)
[![Gemini Vision](https://img.shields.io/badge/Powered%20by-Gemini%20Vision-orange?style=for-the-badge&logo=google)](https://ai.google.dev)
[![License](https://img.shields.io/badge/License-Personal%20Use-lightgrey?style=for-the-badge)](#license)

**🔗 [Try CodeSnapper Live](https://code-snapper.onrender.com)**

---

## Table of Contents

- [What is CodeSnapper?](#what-is-codesnapper)
- [Features](#features)
- [Usage Limits](#usage-limits)
- [Tech Stack](#tech-stack)
- [How It Works](#how-it-works)
- [Local Development](#local-development)
- [Security & Privacy](#security--privacy)
- [Roadmap](#roadmap)
- [Authors](#authors)
- [License](#license)

---

## What is CodeSnapper?

CodeSnapper is a premium, dark-themed **code screenshot to text converter** that lets you upload, paste, photograph, or batch-process screenshots of code and instantly get back clean, copy-ready source — with exact indentation, syntax highlighting, and every special character preserved.

Unlike traditional OCR tools, CodeSnapper uses **Google Gemini Vision AI** to understand code structure, not just recognize text — meaning brackets, whitespace, and indentation come out exactly right.

No more manually retyping code from tutorials, textbooks, whiteboards, or someone else's screen.

---

## Features

### 📥 Input methods
- 📸 **Upload** — file picker, single or multiple images
- 📋 **Paste** — Ctrl+V / Cmd+V directly from clipboard
- 🖱️ **Drag & drop** — drop images anywhere on the upload zone
- 📷 **Camera capture** — point your phone at a whiteboard, projector screen, or printed page and capture code live (rear camera on mobile, webcam on desktop)

### ✂️ Crop modes
- **Auto Crop** — AI detects the code block boundary automatically and extracts with zero clicks
- **Manual Crop** — simple drag-to-select crop tool, touch-friendly on mobile

### 🤖 Extraction
- **Gemini Vision AI** — not traditional OCR; preserves exact indentation, whitespace, and every special character
- **Syntax highlighting** — auto-detects Python, JavaScript, HTML, CSS, Java, C++, and more
- **One-click Copy Code** — copies raw code only, nothing else
- **Confidence flagging** — highlights specific characters the AI was uncertain about

### 🗂️ Batch processing
- Process up to 5 images at once (anonymous) or 10 images (signed in)
- Sequential processing with per-image progress tracking
- Tabbed results — Image 1, Image 2... each with its own Copy button
- **Copy All** — concatenates all results in order with separator comments
- Graceful per-image error handling — one failure doesn't stop the rest

### 🔐 Auth & limits
- 25 free extractions for anonymous users (tracked server-side by IP)
- Email sign-up for 50 extractions per rolling 24-hour window
- Passwords hashed with bcrypt (12 rounds)

### 🔒 Privacy & security
- Images never stored — discarded from memory immediately after extraction
- API key lives server-side only — users never see or touch it
- Automatic token refresh — credentials refresh in the background, no manual key updates needed

---

## Usage Limits

| User type | Limit |
|---|---|
| Anonymous | 25 free extractions (server-side IP tracking) |
| Signed-in | 50 extractions per rolling 24-hour window |
| Batch (anonymous) | Up to 5 images per batch |
| Batch (signed-in) | Up to 10 images per batch |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | HTML, CSS, JavaScript, Highlight.js |
| Backend | Node.js, Express.js |
| Database | SQLite (via better-sqlite3) |
| AI Vision | Google Gemini Vision API |
| Auth | bcrypt (12 rounds) + custom email/password |
| Token refresh | google-auth-library (automatic background refresh) |
| Package manager | pnpm |
| Hosting | Render |
| Uptime monitoring | UptimeRobot (prevents cold starts) |

---

## How It Works

```
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
```

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
ADMIN_PASSWORD=your_admin_password_here
```

> ⚠️ Never commit your `.env` file. It is listed in `.gitignore`.

### Admin Panel

View submitted feedback and bug reports at:
```
http://localhost:3000/admin/feedback
```
Password protected via `ADMIN_PASSWORD` in `.env`.

---

## Security & Privacy

- Passwords hashed with **bcrypt** (cost factor 12) — zero plaintext storage
- API key lives server-side only — users never see or touch it
- Automatic credential refresh via google-auth-library — no manual token updates
- `.env` and `*.db` files are gitignored — no secrets in the repo
- Images discarded from memory immediately after extraction
- Anonymous rate limiting enforced server-side by IP

---

## Roadmap

- [x] Single image extraction
- [x] Auto Crop + Manual Crop
- [x] Batch upload (up to 10 images)
- [x] Camera / Lens capture
- [x] Email auth + rate limiting
- [x] Built-in feedback/bug report system
- [x] Admin panel for feedback review
- [ ] Extraction history for signed-in users
- [ ] Shareable result links (text only, auto-expiring)
- [ ] Custom domain

---

## Authors

Built by **Mubashir Shaikh** with **Claude (Anthropic)**

---

## License

This project is for personal/educational use. All rights reserved © 2026 Mubashir Shaikh.

---

> 💡 **Tip:** CodeSnapper saves you retyping, not learning. Understand the code before you use it — don't just copy-paste blind.

---

<p align="center">
  <sub>Keywords: code screenshot to text, image to code converter, extract code from image, OCR for code, code from screenshot AI, copy code from picture, whiteboard code extractor</sub>
</p>
