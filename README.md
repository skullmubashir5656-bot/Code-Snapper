# CodeSnapper 🔍 — Extract Code from Screenshots with AI

> **Turn any code screenshot into clean, copy-ready source code — instantly, powered by Vision AI via OpenRouter.**

CodeSnapper is a free online tool to extract code from images and screenshots. Upload a photo of code from a tutorial, textbook, whiteboard, or another screen, and get back perfectly formatted, syntax-highlighted, copy-paste-ready code in seconds — no manual retyping required.

[![Live Demo](https://img.shields.io/badge/Live%20Demo-code--snapper.onrender.com-blue?style=for-the-badge)](https://code-snapper.onrender.com)
[![Node.js](https://img.shields.io/badge/Node.js-v24-green?style=for-the-badge&logo=node.js)](https://nodejs.org)
[![OpenRouter](https://img.shields.io/badge/API-OpenRouter-purple?style=for-the-badge)](https://openrouter.ai)
[![Vision AI](https://img.shields.io/badge/Powered%20by-Vision%20AI-orange?style=for-the-badge)](https://openrouter.ai)
[![License](https://img.shields.io/badge/License-Personal%20Use-lightgrey?style=for-the-badge)](#license)

**🔗 [Try CodeSnapper Live](https://code-snapper.onrender.com)**

---

## Table of Contents

- [What is CodeSnapper?](#what-is-codesnapper)
- [Features](#features)
- [Vision API & Multi-Model Fallback](#vision-api--multi-model-fallback)
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

CodeSnapper is a dark-themed **code screenshot-to-text extractor** that lets you upload, paste, photograph, or batch-process screenshots of code and instantly get back clean, copy-ready source — with exact indentation, syntax highlighting, and every special character preserved.

Unlike traditional OCR tools, CodeSnapper uses **advanced Vision AI models** (routed through **OpenRouter**) to understand code structure, eliminate line numbers/gutter noise, and transcribe complex source accurately across all major programming languages.

No more manually retyping code from tutorials, textbooks, whiteboards, or someone else's screen.

---

## Features

### 📥 Input Methods & Camera Lens
- 📸 **Upload** — file picker supporting single or multiple images (PNG, JPG, WEBP, GIF)
- 📋 **Paste** — `Ctrl+V` / `Cmd+V` directly from clipboard
- 🖱️ **Drag & drop** — drop image files anywhere onto the upload zone
- 📷 **Camera Lens & Blur Detection** — point your device camera at any whiteboard, monitor, or textbook. Snap up to 5 photos per session (10 for signed-in users) with a live thumbnail strip, photo deletion, and client-side **blur detection** that inspects image sharpness before sending to the API.

### ✂️ Precision Crop Modes
- **Auto Crop (zero clicks)** — detects code boundaries automatically and extracts instantly without manual adjustments
- **Manual Crop (drag-to-select)** — simple, intuitive drag-to-select crop tool with no zoom/pan clutter, fully responsive on mobile and desktop

### 🤖 Vision Extraction Engine
- **Multi-Model Vision AI** — preserves exact indentation, whitespace, line breaks, and all special programming characters
- **Automated Line Number Stripping** — strips editor gutters (`122 const x = 1;` $\rightarrow$ `const x = 1;`) and filters out numeric-only line noise
- **Syntax Highlighting** — auto-detects Python, JavaScript, TypeScript, HTML, CSS, Java, C++, C#, SQL, Go, Rust, and more
- **One-click Copy & Copy All** — copies clean source code with per-tab and unified "Copy All" clipboard actions
- **Confidence Flagging** — highlights ambiguous characters if image resolution was degraded

### 🗂️ Batch Processing
- Process up to 5 images per batch (anonymous) or 10 images (signed in)
- Sequential processing with live progress status per image
- Tabbed results interface with individual Copy buttons and a **Copy All** button

### 📜 Extraction History (Signed-in Only)
- Automatically saves **once per extraction** upon confirmed success
- **Auto-Named**: formatted as `[Language] · [Date] [Time in user's local timezone]`
- Full inline **Rename**, **Load into editor**, and **Delete** actions
- **Capacity**: Stores up to 100 entries per user with 90-day automatic deletion
- **100% Text-Only**: Stores extracted code text only — zero images stored on disk

### 🔐 Authentication & Rate Limits
- **Anonymous**: 25 total lifetime extractions tracked server-side by IP address
- **Signed-in**: 50 extractions per rolling 24-hour window
- Secure JWT session handling (30-day token lifetime) with 12-round bcrypt password hashing

### 💬 In-App Feedback & Ratings
- **Report an Issue Modal**: accessible from the footer and results view; submissions are stored directly in the `feedback` database table and viewable by admins at `/admin/feedback`
- **Rate Us Prompt**: triggers a 5-star rating prompt after the user's 30th successful extraction (one-time only)

### 📊 Model Health Monitoring
- Weekly automated health checks across the vision model chain
- Automatically detects deprecated endpoints (HTTP 404) and promotes the next healthy model to primary position

---

## Vision API & Multi-Model Fallback

CodeSnapper connects via the **OpenRouter API** instead of direct Google AI Studio API keys, providing permanent key reliability and seamless multi-model failover:

- **Permanent Key Auth:** Uses OpenRouter API keys (`sk-or-...`) that never expire.
- **Dynamic Failover:** If a primary model attempt encounters a timeout ($10\text{s}$ per model) or rate limit, CodeSnapper automatically switches with exponential backoff to backup models in the fallback chain.
- **Automated Health Checks:** Periodically tests the fallback pipeline every 7 days and dynamically shifts healthy models to the primary position.

---

## Usage Limits

| User type | Limit | Storage / Tracking |
|---|---|---|
| **Anonymous** | 25 free extractions | Server-side IP tracking |
| **Signed-in** | 50 extractions / rolling 24 hours | Persistent database window |
| **Batch (Anonymous)** | Up to 5 images per batch | Sequential auto-crop pipeline |
| **Batch (Signed-in)** | Up to 10 images per batch | Sequential auto-crop pipeline |

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | HTML5, Modern CSS3 (Dark Theme, Responsive), Vanilla JavaScript, Highlight.js |
| **Backend** | Node.js, Express.js |
| **AI Provider** | [OpenRouter API](https://openrouter.ai) (`https://openrouter.ai/api/v1/chat/completions`) |
| **AI Engine** | Multi-Model Vision AI Pipeline with Dynamic Fallback |
| **Database** | Turso (Persistent cloud SQLite) with local SQLite (`better-sqlite3`) fallback |
| **Authentication** | JWT (30-day expiry) + bcryptjs (12 rounds) |
| **Hosting** | Render |

---

## How It Works

```
User uploads / pastes / drags / captures via Camera Lens
                      ↓
       Pre-flight limit check (/api/anon/status)
                      ↓
Auto Crop (zero clicks) or Manual Crop (drag to select)
                      ↓
           POST /api/extract (Base64)
                      ↓
OpenRouter API Proxy → Primary Vision Model
                      ↓ (fails / timeout?)
          Fallback to Secondary Vision Model
                      ↓ (fails / timeout?)
          Fallback to Backup Vision Model
                      ↓
Output post-processing (Language detection & line number stripping)
                      ↓
Syntax-highlighted, copy-ready code displayed in result tabs
```

---

## Local Development

### Prerequisites
- Node.js v20+
- pnpm (`npm i -g pnpm` or `corepack enable`)
- An OpenRouter API Key from [openrouter.ai/keys](https://openrouter.ai/keys)

### Setup

```bash
# Clone the repository
git clone https://github.com/skullmubashir5656-bot/Code-Snapper.git
cd Code-Snapper

# Install dependencies
pnpm install

# Configure environment variables
cp .env.example .env
```

### Environment Variables (`.env`)

```env
# OpenRouter API Key (sk-or-v1-...)
OPENROUTER_API_KEY=your_openrouter_api_key_here

# JWT Secret for User Sessions
JWT_SECRET=your_jwt_secret_key_here

# Admin Dashboard Password
ADMIN_PASSWORD=your_admin_password_here

# Optional: Turso Cloud Database (falls back to local SQLite if omitted)
TURSO_DATABASE_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=your_turso_auth_token_here
```

### Run Locally

```bash
# Start server
pnpm start
# or with nodemon
node server.js
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Admin Dashboard

View submitted user feedback, bug reports, and ratings at:
```
http://localhost:3000/admin/feedback
```
*(Also accessible at `http://localhost:3000/admin.html`, protected by `ADMIN_PASSWORD`)*

---

## Security & Privacy

- **No Image Storage:** Uploaded images are processed in-memory and discarded immediately after extraction.
- **Server-Side API Key:** Users never see or touch the OpenRouter API credentials.
- **Encrypted Credentials:** Passwords stored using 12-round bcrypt hashing.
- **IP-Based Anonymous Limits:** Anonymous rate limits are tracked securely on the backend server.
- **Git Hygiene:** All `.env` files, database files (`*.db`), and cache files are strictly gitignored.

---

## Roadmap

- [x] Single & multi-image code extraction
- [x] Auto Crop + Manual Crop
- [x] Multi-photo Camera Lens with blur detection
- [x] OpenRouter API integration with multi-model fallback chain
- [x] Automated 7-day model health checks & auto-promotion
- [x] Automated line number gutter stripping
- [x] Email authentication & rolling 24-hour rate limiting
- [x] Extraction history for signed-in users
- [x] In-app feedback and star rating system
- [x] Mobile navigation drawer & responsive UI

---

## Authors

Built by **Mubashir Shaikh**

---

## License

This project is for personal/educational use. All rights reserved © 2026 Mubashir Shaikh.

---

<p align="center">
  <sub>Keywords: code screenshot to text, image to code converter, extract code from image, LLM for code, code from screenshot AI, copy code from picture, whiteboard code extractor, OpenRouter, Vision AI</sub>
</p>

