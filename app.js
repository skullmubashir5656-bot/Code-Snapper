/**
 * CodeSnapper — app.js
 * AI-powered code extraction from screenshots
 * Backend proxy → Gemini Vision · Highlight.js · Canvas crop tools
 */

'use strict';

/* ═══════════════════════════════════════════════
   CONSTANTS
═══════════════════════════════════════════════ */
const MAX_FILE_SIZE       = 10 * 1024 * 1024; // 10 MB
const MAX_EXTRACTIONS     = 25;               // legacy alias
const MAX_ANON_EXTRACTIONS= 25;               // anonymous limit (triggers auth modal)
const STORAGE_KEY_CNT  = 'codesnapper_count';
const STORAGE_KEY_UID  = 'codesnapper_uid';
const STORAGE_KEY_AUTH = 'codesnapper_auth';  // JWT + email cached in localStorage
const EXTRACT_API      = '/api/extract';      // server-side proxy — no key in browser

const LANG_EXT_MAP = {
  python: 'py', javascript: 'js', typescript: 'ts', html: 'html',
  css: 'css', java: 'java', cpp: 'cpp', c: 'c', csharp: 'cs',
  go: 'go', rust: 'rs', ruby: 'rb', php: 'php', swift: 'swift',
  kotlin: 'kt', shell: 'sh', bash: 'sh', sql: 'sql', r: 'r',
  dart: 'dart', scala: 'scala', yaml: 'yml', json: 'json',
  xml: 'xml', markdown: 'md', plaintext: 'txt',
};

/* Mobile nav auth updater — assigned inside bindEvents(), called by updateUserPill() */
let updateMobileNavAuth = () => {};

/* ═══════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════ */
const state = {
  panel:        'hero',        // hero | crop-select | auto-crop | manual-crop | processing | result
  uploadedFile: null,          // File object
  uploadedImg:  null,          // HTMLImageElement (loaded)
  uploadedDataURL: null,       // original data URL
  croppedDataURL: null,        // cropped data URL sent to API
  extractedCode: '',
  rawResponse:   '',
  detectedLang:  'plaintext',
  ambiguities:   [],
  autoCropper:   null,         // AutoCropper instance
  manualCropper: null,         // ManualCropper instance
  // Auth
  authToken:     null,         // JWT string or null
  authEmail:     null,         // signed-in email
  authRemaining: null,         // extractions remaining this window (number or null)
  pendingExtract:false,        // true when extraction was queued but auth modal was shown
};

/* ═══════════════════════════════════════════════
   ELEMENT REFS
═══════════════════════════════════════════════ */
const $ = id => document.getElementById(id);

const els = {
  heroPanel:       $('hero-panel'),
  appSection:      $('app-section'),
  cropSelectPanel: $('crop-select-panel'),
  autoCropPanel:   $('auto-crop-panel'),
  manualCropPanel: $('manual-crop-panel'),
  processingPanel: $('processing-panel'),
  resultPanel:     $('result-panel'),

  uploadArea:      $('upload-area'),
  fileInput:       $('file-input'),
  usageCount:      $('usage-count'),
  usageFill:       $('usage-fill'),
  usageProgress:   $('usage-progress'),

  cropPreviewImg:  $('crop-preview-img'),
  changeImgBtn:    $('change-img-btn'),
  autoCropBtn:     $('auto-crop-btn'),
  manualCropBtn:   $('manual-crop-btn'),

  autoCropCanvas:  $('auto-crop-canvas'),
  autoBackBtn:     $('auto-back-btn'),
  autoExtractBtn:  $('auto-extract-btn'),

  manualCropCanvas:$('manual-crop-canvas'),
  manualBackBtn:   $('manual-back-btn'),
  manualExtractBtn:$('manual-extract-btn'),
  zoomInBtn:       $('zoom-in-btn'),
  zoomOutBtn:      $('zoom-out-btn'),
  zoomFitBtn:      $('zoom-fit-btn'),
  zoomDisplay:     $('zoom-display'),
  manualResetBtn:  $('manual-reset-btn'),
  manualHintLbl:   $('manual-hint-lbl'),

  step1: $('step-1'), step2: $('step-2'),
  step3: $('step-3'), step4: $('step-4'),
  procStatusText: $('proc-status-text'),

  langChip:        $('lang-chip'),
  langName:        $('lang-name'),
  codeOutput:      $('code-output'),
  codeFilename:    $('code-filename'),
  originalCompare: $('original-compare'),
  originalImgDisp: $('original-img-display'),
  ambigSection:    $('ambig-section'),
  ambigList:       $('ambig-list'),
  copyBtn:         $('copy-btn'),
  viewOriginalBtn: $('view-original-btn'),
  tryAgainBtn:     $('try-again-btn'),
  extractAnotherBtn: $('extract-another-btn'),

  limitModal:       null,   // removed — replaced by auth-modal

  // auth modal
  authModal:          $('auth-modal'),
  authModalClose:     $('auth-modal-close'),
  authModalDesc:      $('auth-modal-desc'),
  tabSignin:          $('tab-signin'),
  tabSignup:          $('tab-signup'),
  authSigninPane:     $('auth-signin-pane'),
  authSignupPane:     $('auth-signup-pane'),
  signinEmail:        $('signin-email'),
  signinPassword:     $('signin-password'),
  signinEye:          $('signin-eye'),
  signinEyeShow:      $('signin-eye-show'),
  signinEyeHide:      $('signin-eye-hide'),
  signinError:        $('signin-error'),
  signinBtn:          $('signin-btn'),
  authCancelBtn:      $('auth-cancel-btn'),
  signupEmail:        $('signup-email'),
  signupPassword:     $('signup-password'),
  signupEye:          $('signup-eye'),
  signupEyeShow:      $('signup-eye-show'),
  signupEyeHide:      $('signup-eye-hide'),
  signupError:        $('signup-error'),
  pwStrengthFill:     $('pw-strength-fill'),
  pwStrengthLbl:      $('pw-strength-lbl'),
  signupBtn:          $('signup-btn'),
  authSignupCancelBtn:$('auth-signup-cancel-btn'),

  signupPasswordConfirm: $('signup-password-confirm'),

  // user pill (header) & hero callout
  navSigninBtn:   $('nav-signin-btn'),
  userPill:       $('user-pill'),
  userPillEmail:  $('user-pill-email'),
  userPillRemaining: $('user-pill-remaining'),
  signoutBtn:     $('signout-btn'),
  heroAuthCallout:$('hero-auth-callout'),
  heroSigninBtn:  $('hero-signin-btn'),

  errorModal:       $('error-modal'),
  errorModalMsg:    $('error-modal-msg'),
  errorModalClose:  $('error-modal-close'),
  errorModalCancel: $('error-modal-cancel'),
  errorRetryBtn:    $('error-retry-btn'),

  toast:    $('toast'),
  toastMsg: $('toast-msg'),

  historySection: $('history-section'),
  historyList:    $('history-list'),
};

/* ═══════════════════════════════════════════════
   PANEL MANAGEMENT
═══════════════════════════════════════════════ */
function showPanel(name) {
  state.panel = name;

  // Always restore body scroll — modals temporarily set overflow:hidden
  document.body.style.overflow = '';

  const heroVisible     = name === 'hero';
  const appVisible      = name !== 'hero';
  const cropSelectVis   = name === 'crop-select';
  const autoCropVis     = name === 'auto-crop';
  const manualCropVis   = name === 'manual-crop';
  const processingVis   = name === 'processing';
  const resultVis       = name === 'result';

  els.heroPanel.classList.toggle('hidden', !heroVisible);
  els.appSection.classList.toggle('hidden', !appVisible);
  els.cropSelectPanel.classList.toggle('hidden', !cropSelectVis);
  els.autoCropPanel.classList.toggle('hidden', !autoCropVis);
  els.manualCropPanel.classList.toggle('hidden', !manualCropVis);
  els.processingPanel.classList.toggle('hidden', !processingVis);
  els.resultPanel.classList.toggle('hidden', !resultVis);

  if (appVisible) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

/* ═══════════════════════════════════════════════
   AUTH  —  storage, API, UI
═══════════════════════════════════════════════ */
function loadAuth() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_AUTH);
    if (!raw) return;
    const { token, email, remaining } = JSON.parse(raw);
    state.authToken     = token     || null;
    state.authEmail     = email     || null;
    state.authRemaining = remaining ?? null;
  } catch { /* corrupt — ignore */ }
}

function saveAuth(token, email, remaining) {
  state.authToken     = token;
  state.authEmail     = email;
  state.authRemaining = remaining ?? null;
  localStorage.setItem(STORAGE_KEY_AUTH, JSON.stringify({ token, email, remaining }));
}

function clearAuth() {
  state.authToken = state.authEmail = state.authRemaining = null;
  localStorage.removeItem(STORAGE_KEY_AUTH);
}

/* Verify JWT with server and refresh remaining count */
async function refreshAuthState() {
  if (!state.authToken) return;
  try {
    const r = await fetch('/api/auth/me', {
      headers: { 'Authorization': `Bearer ${state.authToken}` }
    });
    if (r.ok) {
      const d = await r.json();
      state.authRemaining = d.remaining;
      localStorage.setItem(STORAGE_KEY_AUTH,
        JSON.stringify({ token: state.authToken, email: state.authEmail, remaining: d.remaining }));
    } else {
      // token expired or account gone
      clearAuth();
    }
  } catch { /* offline — keep cached state */ }
}

/* ─── EXTRACTION HISTORY (Signed-in users) ─────────────────────── */
async function fetchHistory() {
  if (!els.historySection || !els.historyList) return;
  if (!state.authToken) {
    els.historySection.classList.add('hidden');
    return;
  }

  try {
    const res = await fetch('/api/history', {
      headers: { 'Authorization': `Bearer ${state.authToken}` }
    });
    if (res.ok) {
      const data = await res.json();
      renderHistory(data.history || []);
    } else {
      els.historySection.classList.add('hidden');
    }
  } catch {
    els.historySection.classList.add('hidden');
  }
}

function formatRelativeTime(timestamp) {
  const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}d ago`;
}

function renderHistory(items) {
  if (!items || items.length === 0) {
    els.historySection.classList.add('hidden');
    return;
  }

  els.historySection.classList.remove('hidden');
  els.historyList.innerHTML = items.map(item => {
    const snippet = item.codeText.replace(/\s+/g, ' ').slice(0, 65) + (item.codeText.length > 65 ? '…' : '');
    const timeStr = formatRelativeTime(item.createdAt);
    const langLabel = (item.lang && item.lang !== 'auto') ? item.lang : 'CODE';

    return `
      <div class="history-item" role="listitem" data-id="${item.id}">
        <div class="history-item-left">
          <span class="history-lang-badge">${escapeHtml(langLabel)}</span>
          <span class="history-code-snippet" title="${escapeHtml(item.codeText.slice(0, 200))}">${escapeHtml(snippet)}</span>
        </div>
        <div class="history-item-right">
          <span class="history-time">${timeStr}</span>
          <button class="btn btn-secondary history-restore-btn" onclick="restoreHistoryItem(${item.id})">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
            Restore
          </button>
        </div>
      </div>
    `;
  }).join('');

  window._recentExtractions = items;
}

window.restoreHistoryItem = function(id) {
  const item = (window._recentExtractions || []).find(i => i.id === id);
  if (!item) return;

  const { html, lang } = detectAndHighlight(item.codeText);
  state.extractedCode = item.codeText;
  state.detectedLang  = lang;
  state.ambiguities   = [];
  state.rawResponse   = item.codeText;

  displayResult(item.codeText, html, lang, []);
  showToast('Restored extraction from history!');
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

/* Update the header user pill */
function updateUserPill() {
  const signedIn = !!state.authToken;
  els.navSigninBtn.classList.toggle('hidden', signedIn); // Always visible when signed out!
  els.userPill.classList.toggle('hidden', !signedIn);
  if (els.heroAuthCallout) {
    els.heroAuthCallout.classList.toggle('hidden', signedIn);
  }
  if (signedIn) {
    // Truncate email for small screens
    const email = state.authEmail || '';
    els.userPillEmail.textContent = email.length > 20 ? email.slice(0, 18) + '…' : email;
    const rem = state.authRemaining;
    els.userPillRemaining.textContent = rem !== null
      ? `${rem}/50 left today`
      : '50/day';
    els.userPillRemaining.style.color = (rem !== null && rem <= 5) ? 'var(--warning)' : 'var(--txt-2)';
    fetchHistory();
  } else {
    if (els.historySection) els.historySection.classList.add('hidden');
  }
  // Keep mobile drawer auth section in sync
  updateMobileNavAuth();
}

/* ── AUTH MODAL UI ──────────────────────────────────────────── */
function openAuthModal(opts = {}) {
  // Reset fields and errors
  els.signinEmail.value = els.signinPassword.value = '';
  els.signupEmail.value = els.signupPassword.value = '';
  if (els.signupPasswordConfirm) els.signupPasswordConfirm.value = '';
  els.signinError.classList.add('hidden');
  els.signupError.classList.add('hidden');
  els.pwStrengthFill.style.width = '0%';
  els.pwStrengthLbl.textContent = '';

  // Default to sign-in tab; switch to signup if requested
  switchAuthTab(opts.tab === 'signup' ? 'signup' : 'signin');

  if (opts.fromLimit) {
    els.authModalDesc.innerHTML =
      'You’ve used all 25 free extractions. Sign in or create a free account to get ' +
      '<strong>50 extractions per day</strong> — resets every 24 hours.';
  } else {
    els.authModalDesc.innerHTML =
      'Sign in or create a free account to unlock <strong>50 extractions per day</strong>.';
  }

  openModal(els.authModal);
  setTimeout(() => (opts.tab === 'signup' ? els.signupEmail : els.signinEmail).focus(), 80);
}

function closeAuthModal() { closeModal(els.authModal); }

function switchAuthTab(tab) {
  const isSignin = tab === 'signin';
  els.tabSignin.classList.toggle('active', isSignin);
  els.tabSignup.classList.toggle('active', !isSignin);
  els.tabSignin.setAttribute('aria-selected', isSignin);
  els.tabSignup.setAttribute('aria-selected', !isSignin);
  els.authSigninPane.classList.toggle('hidden', !isSignin);
  els.authSignupPane.classList.toggle('hidden', isSignin);
}

/* Password-strength meter */
function updateStrength(pw) {
  let score = 0;
  if (pw.length >= 8)  score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;

  const levels = [
    { pct: '20%',  color: 'var(--danger)',  lbl: 'Too short' },
    { pct: '40%',  color: 'var(--warning)', lbl: 'Weak' },
    { pct: '60%',  color: 'var(--warning)', lbl: 'Fair' },
    { pct: '80%',  color: 'var(--info)',    lbl: 'Good' },
    { pct: '100%', color: 'var(--success)', lbl: 'Strong' },
  ];
  const lv = levels[Math.max(0, score - 1)] || levels[0];
  els.pwStrengthFill.style.width  = pw.length ? lv.pct  : '0%';
  els.pwStrengthFill.style.background = pw.length ? lv.color : '';
  els.pwStrengthLbl.textContent   = pw.length ? lv.lbl  : '';
  els.pwStrengthLbl.style.color   = pw.length ? lv.color : '';
}

/* Toggle password visibility */
function toggleEye(inputEl, eyeShow, eyeHide) {
  const isText = inputEl.type === 'text';
  inputEl.type = isText ? 'password' : 'text';
  eyeShow.classList.toggle('hidden', !isText);
  eyeHide.classList.toggle('hidden', isText);
}

/* ── AUTH API calls ──────────────────────────────────────────── */
async function apiAuth(endpoint, email, password) {
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Authentication failed.');
  return d;
}

async function handleSignIn() {
  const email    = els.signinEmail.value.trim();
  const password = els.signinPassword.value;
  els.signinError.classList.add('hidden');
  els.signinBtn.disabled = true;
  els.signinBtn.textContent = 'Signing in…';
  try {
    const d = await apiAuth('/api/auth/login', email, password);
    saveAuth(d.token, d.email, d.remaining);
    closeAuthModal();
    updateUserPill();
    showToast(`Welcome back, ${d.email.split('@')[0]}!`);
    if (state.pendingExtract) { state.pendingExtract = false; runExtraction(state.croppedDataURL); }
  } catch (e) {
    els.signinError.textContent = e.message;
    els.signinError.classList.remove('hidden');
  } finally {
    els.signinBtn.disabled = false;
    els.signinBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg> Sign in';
  }
}

async function handleSignUp() {
  const email       = els.signupEmail.value.trim();
  const password    = els.signupPassword.value;
  const confirmPass = els.signupPasswordConfirm ? els.signupPasswordConfirm.value : '';

  els.signupError.classList.add('hidden');

  if (!email || !password) {
    els.signupError.textContent = 'Email and password are required.';
    els.signupError.classList.remove('hidden');
    return;
  }

  if (password.length < 8) {
    els.signupError.textContent = 'Password must be at least 8 characters.';
    els.signupError.classList.remove('hidden');
    return;
  }

  if (password !== confirmPass) {
    els.signupError.textContent = 'Passwords do not match. Please re-enter passwords.';
    els.signupError.classList.remove('hidden');
    return;
  }

  els.signupBtn.disabled = true;
  els.signupBtn.textContent = 'Creating account…';
  try {
    const d = await apiAuth('/api/auth/register', email, password);
    saveAuth(d.token, d.email, d.remaining);
    closeAuthModal();
    updateUserPill();
    showToast(`Account created! Welcome, ${d.email.split('@')[0]} ✨`);
    if (state.pendingExtract) { state.pendingExtract = false; runExtraction(state.croppedDataURL); }
  } catch (e) {
    els.signupError.textContent = e.message;
    els.signupError.classList.remove('hidden');
  } finally {
    els.signupBtn.disabled = false;
    els.signupBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg> Create account &amp; continue';
  }
}

/* ═══════════════════════════════════════════════
   USAGE TRACKING  (anon only — signed-in tracked server-side)
═══════════════════════════════════════════════ */
function getCount()  { return parseInt(localStorage.getItem(STORAGE_KEY_CNT) || '0', 10); }
function incCount()  { localStorage.setItem(STORAGE_KEY_CNT, String(getCount() + 1)); }
function isLimited() {
  if (state.authToken) return false;          // signed-in: server decides
  return getCount() >= MAX_ANON_EXTRACTIONS;
}

function updateUsageUI() {
  const n = getCount();
  els.usageCount.textContent = n;
  const pct = Math.min(100, (n / MAX_EXTRACTIONS) * 100);
  els.usageFill.style.width = pct + '%';
  els.usageProgress.setAttribute('aria-valuenow', n);
}

/* ═══════════════════════════════════════════════
   MODALS
═══════════════════════════════════════════════ */
function openModal(el)  { el.classList.remove('hidden'); document.body.style.overflow = 'hidden'; }
function closeModal(el) { el.classList.add('hidden');    document.body.style.overflow = ''; }

function showError(msg, title = 'Extraction failed') {
  const titleEl = document.getElementById('error-modal-title');
  if (titleEl) titleEl.textContent = title;
  els.errorModalMsg.textContent = msg || 'An unexpected error occurred.';
  openModal(els.errorModal);
}


/* ═══════════════════════════════════════════════
   TOAST
═══════════════════════════════════════════════ */
let toastTimer;
function showToast(msg = 'Copied!', type = 'success') {
  clearTimeout(toastTimer);
  els.toastMsg.textContent = msg;
  els.toast.style.background = type === 'success' ? 'var(--success)'
                              : type === 'error'   ? 'var(--danger)'
                              : 'var(--purple)';
  els.toast.classList.add('show');
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2600);
}

/* ═══════════════════════════════════════════════
   IMAGE LOADING
═══════════════════════════════════════════════ */
function loadImage(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      return reject(new Error('Please upload an image file (PNG, JPG, WEBP, GIF).'));
    }
    if (file.size > MAX_FILE_SIZE) {
      return reject(new Error(`Image is too large (${(file.size/1024/1024).toFixed(1)} MB). Max is 10 MB.`));
    }

    const reader = new FileReader();
    reader.onload = e => {
      const dataURL = e.target.result;
      const img = new Image();
      img.onload  = () => resolve({ img, dataURL });
      img.onerror = () => reject(new Error('Could not load the image.'));
      img.src = dataURL;
    };
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}

/* ═══════════════════════════════════════════════
   FILE HANDLING
═══════════════════════════════════════════════ */
async function handleFile(file) {
  if (!file) return;
  try {
    const { img, dataURL } = await loadImage(file);
    state.uploadedFile    = file;
    state.uploadedImg     = img;
    state.uploadedDataURL = dataURL;

    // Show crop selection
    els.cropPreviewImg.src = dataURL;
    els.originalImgDisp.src = dataURL;
    showPanel('crop-select');
  } catch (err) {
    showError(err.message);
  }
}

/* ═══════════════════════════════════════════════
   AUTO CROP ALGORITHM
═══════════════════════════════════════════════ */
class AutoCropper {
  constructor(canvas, image) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
    this.image  = image;
    this.rect   = null;   // {x, y, w, h} in IMAGE pixel coords
    this.dragging = null; // handle id being dragged
    this.HANDLE  = 9;     // handle size px (canvas space)
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseUp   = this._onMouseUp.bind(this);
    this._onTouchStart = this._onTouchStart.bind(this);
    this._onTouchMove  = this._onTouchMove.bind(this);
    this._onTouchEnd   = this._onTouchEnd.bind(this);
    this._initCanvas();
  }

  _initCanvas() {
    const img = this.image;
    const maxW = this.canvas.parentElement.clientWidth || 800;
    const maxH = 520;
    const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
    this.canvas.width  = Math.round(img.naturalWidth  * scale);
    this.canvas.height = Math.round(img.naturalHeight * scale);
    this.scale = scale; // image px → canvas px

    this.detect();
    this.render();

    this.canvas.addEventListener('mousedown',  this._onMouseDown);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mouseup',   this._onMouseUp);
    this.canvas.addEventListener('touchstart', this._onTouchStart, { passive: false });
    this.canvas.addEventListener('touchmove',  this._onTouchMove,  { passive: false });
    this.canvas.addEventListener('touchend',   this._onTouchEnd);
  }

  detect() {
    const img = this.image;
    const W = img.naturalWidth, H = img.naturalHeight;

    // ── Downsample for speed (max 700px on longest side) ─────────────────────
    const MAXDIM  = 700;
    const dScale  = Math.min(1, MAXDIM / Math.max(W, H));
    const dW      = Math.max(1, Math.round(W * dScale));
    const dH      = Math.max(1, Math.round(H * dScale));
    const off     = document.createElement('canvas');
    off.width = dW; off.height = dH;
    const ctx2 = off.getContext('2d');
    ctx2.drawImage(img, 0, 0, dW, dH);
    const px = ctx2.getImageData(0, 0, dW, dH).data;

    const at  = (x, y) => (y * dW + x) * 4;
    const rgb = (x, y) => { const i = at(x, y); return [px[i], px[i+1], px[i+2]]; };
    const colorDiff = (a, b) => Math.abs(a[0]-b[0]) + Math.abs(a[1]-b[1]) + Math.abs(a[2]-b[2]);

    // ── 1. Determine outer background via border-strip median ─────────────────
    // Sample entire top/bottom/left/right strips (5% of dimension wide)
    const STRIP = Math.max(4, Math.round(Math.min(dW, dH) * 0.05));
    const borderSamples = [];
    for (let x = 0; x < dW; x++) {
      for (let y = 0; y < STRIP;        y++) borderSamples.push(rgb(x, y));
      for (let y = dH-STRIP; y < dH;   y++) borderSamples.push(rgb(x, y));
    }
    for (let y = STRIP; y < dH-STRIP; y++) {
      for (let x = 0; x < STRIP;        x++) borderSamples.push(rgb(x, y));
      for (let x = dW-STRIP; x < dW;   x++) borderSamples.push(rgb(x, y));
    }
    // Median of each channel = robust outer background colour
    const sortCh = ch => borderSamples.map(p => p[ch]).sort((a,b) => a-b);
    const mid = Math.floor(borderSamples.length / 2);
    const outerBg = [sortCh(0)[mid], sortCh(1)[mid], sortCh(2)[mid]];

    // ── 2. Build row & column "foreignness" profiles ──────────────────────────
    // A pixel is "foreign" (= not outer background) if its L1 colour diff > threshold
    const DIFF_THRESH = 28;
    const rowForeign = new Float32Array(dH);
    const colForeign = new Float32Array(dW);

    for (let y = 0; y < dH; y++) {
      let n = 0;
      for (let x = 0; x < dW; x++) {
        if (colorDiff(rgb(x, y), outerBg) > DIFF_THRESH) n++;
      }
      rowForeign[y] = n / dW;
    }
    for (let x = 0; x < dW; x++) {
      let n = 0;
      for (let y = 0; y < dH; y++) {
        if (colorDiff(rgb(x, y), outerBg) > DIFF_THRESH) n++;
      }
      colForeign[x] = n / dH;
    }

    // ── 3. Smooth the profiles (Gaussian-ish box filter) ─────────────────────
    const boxSmooth = (arr, k) => {
      const out = new Float32Array(arr.length);
      for (let i = 0; i < arr.length; i++) {
        let s = 0, n = 0;
        for (let d = -k; d <= k; d++) {
          const j = i + d;
          if (j >= 0 && j < arr.length) { s += arr[j]; n++; }
        }
        out[i] = s / n;
      }
      return out;
    };
    const K = Math.max(1, Math.round(Math.min(dW, dH) * 0.01));
    const sRow = boxSmooth(rowForeign, K);
    const sCol = boxSmooth(colForeign, K);

    // ── 4. Find content bounding box using adaptive threshold ─────────────────
    // Threshold = 12% of the peak density (ignores sparse UI chrome)
    const rowPeak = Math.max(...sRow);
    const colPeak = Math.max(...sCol);
    const rowThr  = rowPeak * 0.12;
    const colThr  = colPeak * 0.12;

    let top = -1, bottom = -1, left = -1, right = -1;
    for (let y = 0; y < dH; y++) {
      if (sRow[y] >= rowThr) { if (top    === -1) top    = y; bottom = y; }
    }
    for (let x = 0; x < dW; x++) {
      if (sCol[x] >= colThr) { if (left   === -1) left   = x; right  = x; }
    }

    // Fallback: use whole image
    if (top === -1)  { top = 0; bottom = dH-1; }
    if (left === -1) { left = 0; right  = dW-1; }

    // ── 5. Inward refinement: trim leading/trailing sparse rows/cols ──────────
    // Trim rows from top/bottom that are below 20% of peak
    const trimThr = rowPeak * 0.20;
    while (top    < bottom && sRow[top]    < trimThr) top++;
    while (bottom > top    && sRow[bottom] < trimThr) bottom--;
    const ctrimThr = colPeak * 0.20;
    while (left   < right  && sCol[left]   < ctrimThr) left++;
    while (right  > left   && sCol[right]  < ctrimThr) right--;

    // ── 6. Scale back to full image coords ───────────────────────────────────
    const iS = 1 / dScale;
    top    = Math.round(top    * iS);
    bottom = Math.round(bottom * iS);
    left   = Math.round(left   * iS);
    right  = Math.round(right  * iS);

    // ── 7. Apply modest padding (6%) — detection is now tight ─────────────────
    const padX = Math.round((right - left) * 0.06);
    const padY = Math.round((bottom - top) * 0.06);

    this.rect = {
      x: Math.max(0, left   - padX),
      y: Math.max(0, top    - padY),
      w: Math.min(W, right  - left + 1 + 2*padX),
      h: Math.min(H, bottom - top  + 1 + 2*padY),
    };
    if (this.rect.x + this.rect.w > W) this.rect.w = W - this.rect.x;
    if (this.rect.y + this.rect.h > H) this.rect.h = H - this.rect.y;
  }

  // Image coords → canvas coords
  ic(ix) { return Math.round(ix * this.scale); }

  // Canvas coords → image coords
  ci(cx) { return Math.round(cx / this.scale); }

  _rectCanvas() {
    const r = this.rect;
    return {
      x: this.ic(r.x), y: this.ic(r.y),
      w: this.ic(r.w), h: this.ic(r.h),
    };
  }

  _handles() {
    const { x, y, w, h } = this._rectCanvas();
    return [
      { id:'tl', cx: x,     cy: y,     cursor:'nwse-resize' },
      { id:'tm', cx: x+w/2, cy: y,     cursor:'ns-resize'   },
      { id:'tr', cx: x+w,   cy: y,     cursor:'nesw-resize' },
      { id:'ml', cx: x,     cy: y+h/2, cursor:'ew-resize'   },
      { id:'mr', cx: x+w,   cy: y+h/2, cursor:'ew-resize'   },
      { id:'bl', cx: x,     cy: y+h,   cursor:'nesw-resize' },
      { id:'bm', cx: x+w/2, cy: y+h,   cursor:'ns-resize'   },
      { id:'br', cx: x+w,   cy: y+h,   cursor:'nwse-resize' },
    ];
  }

  _hitHandle(mx, my) {
    const H2 = this.HANDLE;
    return this._handles().find(h =>
      Math.abs(mx - h.cx) <= H2 && Math.abs(my - h.cy) <= H2
    );
  }

  _hitRect(mx, my) {
    const { x, y, w, h } = this._rectCanvas();
    return mx >= x && mx <= x+w && my >= y && my <= y+h;
  }

  _getEventPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width  / rect.width;
    const scaleY = this.canvas.height / rect.height;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top)  * scaleY,
    };
  }

  _onMouseDown(e) { this._startDrag(this._getEventPos(e)); }
  _onMouseMove(e) { this._moveDrag(this._getEventPos(e)); }
  _onMouseUp()    { this._endDrag(); }
  _onTouchStart(e) { e.preventDefault(); this._startDrag(this._getEventPos(e)); }
  _onTouchMove(e)  { e.preventDefault(); this._moveDrag(this._getEventPos(e)); }
  _onTouchEnd()    { this._endDrag(); }

  _startDrag(pos) {
    const handle = this._hitHandle(pos.x, pos.y);
    if (handle) {
      this.dragging = { type: 'handle', id: handle.id, startRect: {...this.rect}, startPos: pos };
    } else if (this._hitRect(pos.x, pos.y)) {
      this.dragging = { type: 'move', startRect: {...this.rect}, startPos: pos };
    }
  }

  _moveDrag(pos) {
    if (!this.dragging) return;
    const { startRect, startPos, type, id } = this.dragging;
    const dx = this.ci(pos.x - startPos.x);
    const dy = this.ci(pos.y - startPos.y);
    const W = this.image.naturalWidth, H = this.image.naturalHeight;
    let r = { ...startRect };

    if (type === 'move') {
      r.x = Math.max(0, Math.min(W - r.w, r.x + dx));
      r.y = Math.max(0, Math.min(H - r.h, r.y + dy));
    } else {
      // Handle resize
      if (id.includes('l')) { r.x = Math.max(0, Math.min(r.x+r.w-10, r.x + dx)); r.w = startRect.x+startRect.w - r.x; }
      if (id.includes('r')) { r.w = Math.max(10, Math.min(W - r.x, r.w + dx)); }
      if (id.includes('t')) { r.y = Math.max(0, Math.min(r.y+r.h-10, r.y + dy)); r.h = startRect.y+startRect.h - r.y; }
      if (id.includes('b')) { r.h = Math.max(10, Math.min(H - r.y, r.h + dy)); }
      if (id === 'tm'||id==='bm') { r.x=startRect.x; r.w=startRect.w; }
      if (id === 'ml'||id==='mr') { r.y=startRect.y; r.h=startRect.h; }
    }
    this.rect = r;
    this.render();
  }

  _endDrag() { this.dragging = null; }

  render() {
    const ctx = this.ctx;
    const cw  = this.canvas.width, ch = this.canvas.height;
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(this.image, 0, 0, cw, ch);

    const { x, y, w, h } = this._rectCanvas();

    // Dim overlay
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, cw, ch);

    // Clear (bright) selected area
    ctx.drawImage(this.image,
      this.rect.x, this.rect.y, this.rect.w, this.rect.h,
      x, y, w, h
    );

    // Selection border
    ctx.strokeStyle = '#7c3aed';
    ctx.lineWidth   = 2;
    ctx.strokeRect(x, y, w, h);

    // Rule-of-thirds grid lines
    ctx.strokeStyle = 'rgba(167,139,250,0.25)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x+w/3, y); ctx.lineTo(x+w/3, y+h);
    ctx.moveTo(x+2*w/3, y); ctx.lineTo(x+2*w/3, y+h);
    ctx.moveTo(x, y+h/3); ctx.lineTo(x+w, y+h/3);
    ctx.moveTo(x, y+2*h/3); ctx.lineTo(x+w, y+2*h/3);
    ctx.stroke();
    ctx.setLineDash([]);

    // Handles
    ctx.fillStyle   = '#7c3aed';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth   = 1.5;
    const H2 = this.HANDLE;
    this._handles().forEach(h => {
      ctx.fillRect(h.cx-H2/2, h.cy-H2/2, H2, H2);
      ctx.strokeRect(h.cx-H2/2, h.cy-H2/2, H2, H2);
    });

    // Dimensions label
    const label = `${this.rect.w} × ${this.rect.h} px`;
    ctx.fillStyle = 'rgba(124,58,237,0.8)';
    ctx.font = '12px JetBrains Mono, monospace';
    const tw = ctx.measureText(label).width;
    const lx = Math.min(x + w - tw - 8, cw - tw - 8);
    const ly = y > 24 ? y - 6 : y + h + 16;
    ctx.fillStyle = '#7c3aed';
    ctx.fillText(label, lx, ly);
  }

  /** Crop the image and return a data URL */
  getCroppedDataURL() {
    const { x, y, w, h } = this.rect;
    const oc = document.createElement('canvas');
    oc.width = w; oc.height = h;
    oc.getContext('2d').drawImage(this.image, x, y, w, h, 0, 0, w, h);
    return oc.toDataURL('image/jpeg', 0.95);
  }

  destroy() {
    this.canvas.removeEventListener('mousedown',  this._onMouseDown);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mouseup',   this._onMouseUp);
    this.canvas.removeEventListener('touchstart', this._onTouchStart);
    this.canvas.removeEventListener('touchmove',  this._onTouchMove);
    this.canvas.removeEventListener('touchend',   this._onTouchEnd);
  }
}

/* ═══════════════════════════════════════════════
   MANUAL CROPPER
═══════════════════════════════════════════════ */
class ManualCropper {
  constructor(canvas, image, onSelectionChange) {
    this.canvas  = canvas;
    this.ctx     = canvas.getContext('2d');
    this.image   = image;
    this.dpr     = Math.max(window.devicePixelRatio || 1, 2); // High-DPI for mobile sharpness
    this.zoom    = 1;
    this.panX    = 0;
    this.panY    = 0;
    this.sel     = null;   // {x,y,w,h} in IMAGE natural coords
    this.mode    = 'draw'; // draw|move|resize|pan|pinch
    this.dragging = false;
    this.dragStart = null;
    this.HANDLE  = 11;
    this.spaceDown = false;
    this.onSelectionChange = onSelectionChange || (() => {});
    this._bindEvents();
    this._initCanvas();
  }

  _initCanvas() {
    const parent = this.canvas.parentElement;
    const rect = parent ? parent.getBoundingClientRect() : { width: 800 };
    const cssW = rect.width || 800;
    const cssH = Math.min(window.innerHeight * 0.65, 540);

    this.cssW = cssW;
    this.cssH = cssH;

    // High-DPI buffer scaling: ensures crisp full-resolution rendering on mobile screens
    this.canvas.width  = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.canvas.style.width  = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;

    this.fitImage();
    this.render();
  }

  fitImage() {
    const img = this.image;
    const scX = this.cssW / img.naturalWidth;
    const scY = this.cssH / img.naturalHeight;
    this.zoom = Math.min(scX, scY, 1);
    const sw = img.naturalWidth  * this.zoom;
    const sh = img.naturalHeight * this.zoom;
    this.panX = (this.cssW - sw) / 2;
    this.panY = (this.cssH - sh) / 2;
    this._updateZoomDisplay();
  }

  /* ── coord transforms (mouse/touch CSS px → image natural px) ── */
  _c2i(cx, cy) {
    return { x: (cx - this.panX) / this.zoom, y: (cy - this.panY) / this.zoom };
  }
  _i2c(ix, iy) {
    return { x: ix * this.zoom + this.panX, y: iy * this.zoom + this.panY };
  }
  _selCanvas() {
    if (!this.sel) return null;
    const tl = this._i2c(this.sel.x, this.sel.y);
    return { x: tl.x, y: tl.y, w: this.sel.w * this.zoom, h: this.sel.h * this.zoom };
  }

  /* ── event helpers ── */
  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    const src = e.touches && e.touches.length > 0 ? e.touches[0] : e;
    return { x: src.clientX - r.left, y: src.clientY - r.top };
  }

  _bindEvents() {
    this.canvas.addEventListener('mousedown',  e => this._mdown(e));
    window.addEventListener('mousemove', e => this._mmove(e));
    window.addEventListener('mouseup',   e => this._mup(e));
    this.canvas.addEventListener('wheel', e => { e.preventDefault(); this._wheel(e); }, { passive: false });

    // Mobile touch events with pinch-to-zoom support
    this.canvas.addEventListener('touchstart', e => {
      e.preventDefault();
      if (e.touches.length === 2) {
        this.dragging = false;
        this.mode = 'pinch';
        const t1 = e.touches[0], t2 = e.touches[1];
        this.pinchDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        this.pinchStartZoom = this.zoom;
        return;
      }
      this._mdown(e);
    }, { passive: false });

    this.canvas.addEventListener('touchmove',  e => {
      e.preventDefault();
      if (this.mode === 'pinch' && e.touches.length === 2) {
        const t1 = e.touches[0], t2 = e.touches[1];
        const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        if (this.pinchDist > 0) {
          const scale = dist / this.pinchDist;
          const newZoom = Math.min(10, Math.max(0.1, this.pinchStartZoom * scale));
          this.zoom = newZoom;
          this._updateZoomDisplay();
          this.render();
        }
        return;
      }
      this._mmove(e);
    }, { passive: false });

    this.canvas.addEventListener('touchend', e => {
      if (this.mode === 'pinch') {
        this.mode = 'draw';
      }
      this._mup(e);
    });

    window.addEventListener('keydown', e => {
      if (e.code === 'Space') { this.spaceDown = true; this.canvas.style.cursor = this.dragging ? 'grabbing' : 'grab'; }
    });
    window.addEventListener('keyup', e => {
      if (e.code === 'Space') { this.spaceDown = false; this.canvas.style.cursor = 'crosshair'; }
    });
  }

  _hitsHandle(px, py) {
    const sc = this._selCanvas();
    if (!sc) return null;
    const { x, y, w, h } = sc;
    const H2 = this.HANDLE + 4; // larger touch area for mobile
    const handles = [
      { id:'tl', cx:x,     cy:y     }, { id:'tm', cx:x+w/2, cy:y     }, { id:'tr', cx:x+w,   cy:y     },
      { id:'ml', cx:x,     cy:y+h/2 }, { id:'mr', cx:x+w,   cy:y+h/2 },
      { id:'bl', cx:x,     cy:y+h   }, { id:'bm', cx:x+w/2, cy:y+h   }, { id:'br', cx:x+w,   cy:y+h   },
    ];
    return handles.find(h => Math.abs(px-h.cx) <= H2 && Math.abs(py-h.cy) <= H2) || null;
  }

  _hitsSel(px, py) {
    const sc = this._selCanvas();
    if (!sc) return false;
    return px >= sc.x && px <= sc.x+sc.w && py >= sc.y && py <= sc.y+sc.h;
  }

  _mdown(e) {
    const pos = this._pos(e);
    if (this.spaceDown) {
      this.dragging = true;
      this.mode = 'pan';
      this.dragStart = { ...pos, panX: this.panX, panY: this.panY };
      this.canvas.style.cursor = 'grabbing';
      return;
    }

    const handle = this._hitsHandle(pos.x, pos.y);
    if (handle) {
      this.dragging = true;
      this.mode = 'resize';
      this.dragStart = { ...pos, handleId: handle.id, startSel: {...this.sel} };
    } else if (this._hitsSel(pos.x, pos.y)) {
      this.dragging = true;
      this.mode = 'move';
      this.dragStart = { ...pos, startSel: {...this.sel} };
    } else {
      this.dragging = true;
      this.mode = 'draw';
      const ip = this._c2i(pos.x, pos.y);
      this.sel = null;
      this.dragStart = { ...pos, imgStart: ip };
    }
  }

  _mmove(e) {
    if (!this.dragging) {
      const pos = this._pos(e);
      if (this.spaceDown) { this.canvas.style.cursor = 'grab'; return; }
      if (this._hitsHandle(pos.x, pos.y)) { this.canvas.style.cursor = 'pointer'; }
      else if (this._hitsSel(pos.x, pos.y)) { this.canvas.style.cursor = 'move'; }
      else { this.canvas.style.cursor = 'crosshair'; }
      return;
    }

    const pos = this._pos(e);
    const W = this.image.naturalWidth, H = this.image.naturalHeight;

    if (this.mode === 'pan') {
      this.panX = this.dragStart.panX + (pos.x - this.dragStart.x);
      this.panY = this.dragStart.panY + (pos.y - this.dragStart.y);
    } else if (this.mode === 'draw') {
      const ip = this._c2i(pos.x, pos.y);
      const sx = Math.max(0, Math.min(W, this.dragStart.imgStart.x));
      const sy = Math.max(0, Math.min(H, this.dragStart.imgStart.y));
      const ex = Math.max(0, Math.min(W, ip.x));
      const ey = Math.max(0, Math.min(H, ip.y));
      this.sel = {
        x: Math.min(sx, ex), y: Math.min(sy, ey),
        w: Math.abs(ex - sx), h: Math.abs(ey - sy),
      };
    } else if (this.mode === 'move') {
      const di = this._c2i(pos.x, pos.y);
      const si = this._c2i(this.dragStart.x, this.dragStart.y);
      const dx = di.x - si.x, dy = di.y - si.y;
      const s = this.dragStart.startSel;
      this.sel = {
        x: Math.max(0, Math.min(W-s.w, s.x+dx)),
        y: Math.max(0, Math.min(H-s.h, s.y+dy)),
        w: s.w, h: s.h,
      };
    } else if (this.mode === 'resize') {
      const ip = this._c2i(pos.x, pos.y);
      const si = this._c2i(this.dragStart.x, this.dragStart.y);
      const dx = ip.x - si.x, dy = ip.y - si.y;
      const id = this.dragStart.handleId;
      let s = { ...this.dragStart.startSel };
      if (id.includes('l')) { s.x=Math.max(0,Math.min(s.x+s.w-1,s.x+dx)); s.w=this.dragStart.startSel.x+this.dragStart.startSel.w-s.x; }
      if (id.includes('r')) { s.w=Math.max(1,Math.min(W-s.x,s.w+dx)); }
      if (id.includes('t')) { s.y=Math.max(0,Math.min(s.y+s.h-1,s.y+dy)); s.h=this.dragStart.startSel.y+this.dragStart.startSel.h-s.y; }
      if (id.includes('b')) { s.h=Math.max(1,Math.min(H-s.y,s.h+dy)); }
      this.sel = s;
    }

    this.render();
    this.onSelectionChange(this.sel);
  }

  _mup() {
    this.dragging = false;
    this.mode = 'draw';
    this.canvas.style.cursor = 'crosshair';
    if (this.sel && (this.sel.w < 4 || this.sel.h < 4)) {
      this.sel = null;
    }
    this.render();
    this.onSelectionChange(this.sel);
  }

  _wheel(e) {
    const pos = this._pos(e);
    const delta = -e.deltaY * 0.001;
    const newZoom = Math.min(10, Math.max(0.1, this.zoom * (1 + delta)));
    const ratio = newZoom / this.zoom;
    this.panX = pos.x - (pos.x - this.panX) * ratio;
    this.panY = pos.y - (pos.y - this.panY) * ratio;
    this.zoom = newZoom;
    this._updateZoomDisplay();
    this.render();
  }

  zoomBy(factor) {
    const cx = this.cssW/2, cy = this.cssH/2;
    const newZoom = Math.min(10, Math.max(0.1, this.zoom * factor));
    const ratio = newZoom / this.zoom;
    this.panX = cx - (cx - this.panX) * ratio;
    this.panY = cy - (cy - this.panY) * ratio;
    this.zoom = newZoom;
    this._updateZoomDisplay();
    this.render();
  }

  resetSel() { this.sel = null; this.render(); this.onSelectionChange(null); }

  _updateZoomDisplay() {
    els.zoomDisplay.textContent = Math.round(this.zoom * 100) + '%';
  }

  render() {
    const ctx = this.ctx;
    const dpr = this.dpr;
    const cw = this.canvas.width;
    const ch = this.canvas.height;

    ctx.save();
    ctx.clearRect(0, 0, cw, ch);

    // High-DPI transform scaling
    ctx.scale(dpr, dpr);

    // Background
    ctx.fillStyle = '#0a0a12';
    ctx.fillRect(0, 0, this.cssW, this.cssH);

    // Draw full-resolution image crisply
    const imgW = this.image.naturalWidth  * this.zoom;
    const imgH = this.image.naturalHeight * this.zoom;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.image, this.panX, this.panY, imgW, imgH);

    if (!this.sel || this.sel.w < 2 || this.sel.h < 2) {
      ctx.restore();
      return;
    }

    const sc = this._selCanvas();
    const { x, y, w, h } = sc;

    // Dim overlay
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, this.cssW, this.cssH);

    // Clear selection area with crisp natural-resolution image
    ctx.drawImage(this.image,
      this.sel.x, this.sel.y, this.sel.w, this.sel.h,
      x, y, w, h
    );

    // Marching-ants border
    ctx.strokeStyle = '#7c3aed';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(x+1, y+1, Math.max(1, w-2), Math.max(1, h-2));
    ctx.setLineDash([]);

    // Handles
    const H2 = this.HANDLE;
    const handles = [
      { cx:x,     cy:y     }, { cx:x+w/2, cy:y     }, { cx:x+w, cy:y     },
      { cx:x,     cy:y+h/2 }, { cx:x+w,   cy:y+h/2 },
      { cx:x,     cy:y+h   }, { cx:x+w/2, cy:y+h   }, { cx:x+w, cy:y+h   },
    ];
    handles.forEach(h => {
      ctx.fillStyle   = '#7c3aed';
      ctx.fillRect(h.cx-H2/2, h.cy-H2/2, H2, H2);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth   = 1.5;
      ctx.strokeRect(h.cx-H2/2, h.cy-H2/2, H2, H2);
    });

    // Size label
    const label = `${Math.round(this.sel.w)} × ${Math.round(this.sel.h)} px`;
    ctx.font = '12px JetBrains Mono, monospace';
    const tw = ctx.measureText(label).width;
    const lx = Math.min(x + w - tw - 6, this.cssW - tw - 8);
    const ly = y > 20 ? y - 6 : y + h + 16;
    ctx.fillStyle = '#7c3aed';
    ctx.fillText(label, lx, ly);

    ctx.restore();
  }

  getCroppedDataURL() {
    if (!this.sel || this.sel.w < 2 || this.sel.h < 2) return null;
    const { x, y, w, h } = this.sel;
    const oc = document.createElement('canvas');
    oc.width  = Math.round(w);
    oc.height = Math.round(h);
    oc.getContext('2d').drawImage(this.image,
      Math.round(x), Math.round(y), Math.round(w), Math.round(h),
      0, 0, Math.round(w), Math.round(h)
    );
    return oc.toDataURL('image/jpeg', 0.95);
  }
}

/* ═══════════════════════════════════════════════
   GEMINI API
═══════════════════════════════════════════════ */
const EXTRACTION_PROMPT = `You are CodeSnapper — a precision code extraction engine. Your ONLY task is to transcribe the source code visible in this image.

STRICT RULES — FOLLOW EXACTLY:
1. Output ONLY the raw source code — absolutely nothing else before the code starts
2. Do NOT wrap in markdown code fences (no \`\`\` blocks)
3. Do NOT add any explanations, labels, comments, or descriptions
4. Preserve EXACT indentation — spaces and tabs exactly as shown
5. Preserve ALL special characters exactly: : ; , . ( ) [ ] { } < > / \\ | + - * = ! @ # $ % ^ & ~ ? ' " \` newlines etc.
6. Preserve EXACT line breaks — every line of code on its own line
7. Do NOT modify, fix, or "improve" the code — transcribe it EXACTLY as displayed
8. After the code, if you are uncertain about ANY characters (e.g. digit 0 vs letter O, digit 1 vs letter l, digit 1 vs pipe |, digit 5 vs letter S, comma vs period), add a blank line followed by these ambiguity notes using EXACTLY this format (each on its own line):
   # AMBIGUOUS: line [N]: '[char]' could be '[alternative]'
   These notes come AFTER the code. They must NOT change the code itself.
9. If the image does NOT contain source code or programming language code (for example: photos, artwork, logos, people, or document text without source code), output EXACTLY: # NO_CODE_FOUND

Transcribe the code now:`;

async function callGemini(dataURL) {
  const [header, b64] = dataURL.split(',');
  const mimeMatch = header.match(/data:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';

  const headers = { 'Content-Type': 'application/json' };
  if (state.authToken) headers['Authorization'] = `Bearer ${state.authToken}`;

  const resp = await fetch(EXTRACT_API, {
    method:  'POST',
    headers,
    body:    JSON.stringify({ imageData: b64, mimeType: mime }),
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    const code = data?.code || '';
    const msg  = data?.error || '';

    if (code === 'DAILY_LIMIT') {
      const resetAt = data?.resetAt ? new Date(data.resetAt) : null;
      const resetStr = resetAt ? ` (resets at ${resetAt.toLocaleTimeString()})` : '';
      throw new Error(`DAILY_LIMIT:${msg}${resetStr}`);
    }
    if (code === 'ANON_LIMIT_REACHED') {
      throw new Error('ANON_LIMIT_REACHED');
    }
    if (resp.status === 429 || code === 'RATE_LIMIT') {
      throw new Error('RATE_LIMIT');
    }
    if (resp.status === 401 || code === 'INVALID_API_KEY') {
      throw new Error('SERVER_KEY_ERROR');
    }
    if (resp.status === 500 || code === 'SERVER_CONFIG_ERROR') {
      throw new Error('SERVER_CONFIG_ERROR');
    }
    if (code === 'SAFETY_BLOCK') {
      throw new Error('The image was blocked by content filters. Try cropping to just the code area.');
    }
    throw new Error(msg || `Extraction failed (${resp.status}). Please try again.`);
  }

  // Update remaining count from server response (for signed-in users)
  if (data.remaining !== undefined) {
    state.authRemaining = data.remaining;
    updateUserPill();
  }

  const text = data?.result;
  if (!text) throw new Error('No code content was returned. Please try again.');
  return text;
}

/* ═══════════════════════════════════════════════
   RESPONSE PARSING
═══════════════════════════════════════════════ */
function parseResponse(raw) {
  // Check for no-code marker
  if (raw.trim() === '# NO_CODE_FOUND') {
    return { code: '', ambiguities: [], noCode: true };
  }

  // Remove any leading/trailing markdown fences Gemini might add anyway
  let text = raw.replace(/^```[\w]*\n?/gm, '').replace(/^```\n?/gm, '');

  // Split on AMBIGUOUS lines
  const ambigRegex = /^#\s*AMBIGUOUS:.+$/gm;
  const ambiguities = [];
  let ambigStartIdx = -1;

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^#\s*AMBIGUOUS:/.test(lines[i])) {
      if (ambigStartIdx === -1) ambigStartIdx = i;
      ambiguities.push(lines[i].replace(/^#\s*AMBIGUOUS:\s*/, '').trim());
    }
  }

  let code = ambigStartIdx > 0
    ? lines.slice(0, ambigStartIdx).join('\n')
    : text;

  // Strip trailing blank lines after code
  code = code.replace(/\n+$/, '');

  return { code, ambiguities, noCode: false };
}

/* ═══════════════════════════════════════════════
   LANGUAGE DETECTION & HIGHLIGHTING
═══════════════════════════════════════════════ */
function detectAndHighlight(code) {
  if (!code || !window.hljs) return { html: escapeHtml(code), lang: 'plaintext' };

  try {
    const result = hljs.highlightAuto(code, [
      'python','javascript','typescript','html','css','java','cpp','c','csharp',
      'go','rust','ruby','php','swift','kotlin','bash','shell','sql','r','dart',
      'scala','yaml','json','xml','markdown','plaintext','haskell','lua','perl',
      'objectivec','matlab','powershell','dockerfile','nginx','ini','toml'
    ]);
    return {
      html: result.value,
      lang: result.language || 'plaintext',
    };
  } catch {
    return { html: escapeHtml(code), lang: 'plaintext' };
  }
}

function escapeHtml(t) {
  return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
          .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

/* ═══════════════════════════════════════════════
   PROCESSING STEPS ANIMATION
═══════════════════════════════════════════════ */
function resetSteps() {
  [els.step1, els.step2, els.step3, els.step4].forEach(s => {
    s.classList.remove('active','done');
  });
}

function setStep(n, done = false) {
  const steps = [null, els.step1, els.step2, els.step3, els.step4];
  for (let i = 1; i < n; i++) {
    steps[i].classList.remove('active'); steps[i].classList.add('done');
  }
  if (!done && steps[n]) {
    steps[n].classList.add('active');
  }
}

/* ═══════════════════════════════════════════════
   EXTRACTION FLOW
═══════════════════════════════════════════════ */
async function runExtraction(croppedDataURL) {
  if (isLimited()) {
    state.pendingExtract = true;
    state.croppedDataURL = croppedDataURL;
    openAuthModal({ fromLimit: true });
    return;
  }

  state.croppedDataURL = croppedDataURL;
  showPanel('processing');
  resetSteps();

  let statusTicker = null;

  try {
    // Step 1: Encoding
    setStep(1);
    els.procStatusText.textContent = 'Preparing & encoding image…';
    await delay(120);
    setStep(1, true); setStep(2);

    // Step 2: server-side Gemini call with active status updates
    els.procStatusText.textContent = 'Analyzing image with Gemini Vision AI…';

    const statusUpdates = [
      'Extracting code layout & characters…',
      'Transcribing syntax & line structures…',
      'Finalizing AI vision model output…'
    ];
    let updateIdx = 0;
    statusTicker = setInterval(() => {
      if (updateIdx < statusUpdates.length) {
        els.procStatusText.textContent = statusUpdates[updateIdx++];
      }
    }, 1800);

    let raw;
    try {
      raw = await callGemini(croppedDataURL);
    } catch (err) {
      if (err.message.startsWith('DAILY_LIMIT:')) {
        showPanel('crop-select');
        showError(err.message.replace('DAILY_LIMIT:', ''));
        return;
      }
      if (err.message === 'ANON_LIMIT_REACHED') {
        showPanel('crop-select');
        openAuthModal({ fromLimit: true });
        return;
      }
      if (err.message === 'RATE_LIMIT') {
        throw new Error('Gemini AI is experiencing temporary high traffic. Please wait a few seconds and try again.');
      }
      if (err.message === 'SERVER_CONFIG_ERROR') {
        throw new Error('The server is not ready yet. Please contact the site administrator.');
      }
      if (err.message === 'SERVER_KEY_ERROR') {
        throw new Error('The server could not reach Gemini — the service credentials may have expired. Please try again shortly or contact support.');
      }
      if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError') || err.name === 'TypeError') {
        throw new Error('Cannot reach the CodeSnapper server. Make sure the server is running (pnpm start) and try again.');
      }
      throw err;
    } finally {
      if (statusTicker) clearInterval(statusTicker);
    }

    setStep(2, true); setStep(3);
    await delay(100);

    // Step 3: Parse
    els.procStatusText.textContent = 'Parsing code structure & ambiguities…';
    const parsed = parseResponse(raw);
    await delay(100);

    if (parsed.noCode) {
      setStep(3, true); setStep(4);
      await delay(100);
      showPanel('crop-select');
      showError('No source code detected in this image. Please upload an image containing source code.', 'No Code Detected');
      return;
    }

    setStep(3, true); setStep(4);
    els.procStatusText.textContent = 'Detecting language & highlighting syntax…';

    // Step 4: Highlight
    const { html, lang } = detectAndHighlight(parsed.code);
    await delay(100);
    setStep(4, true);
    await delay(150);

    // Increment anon counter (signed-in users tracked server-side)
    if (!state.authToken) { incCount(); updateUsageUI(); }

    // Show result
    state.extractedCode = parsed.code;
    state.detectedLang  = lang;
    state.ambiguities   = parsed.ambiguities;
    state.rawResponse   = raw;

    displayResult(parsed.code, html, lang, parsed.ambiguities);
  } catch (err) {
    if (statusTicker) clearInterval(statusTicker);
    showPanel('crop-select');
    const msg = err.message || 'Extraction failed.';
    showError(msg);
  }
}

function displayResult(code, highlightedHtml, lang, ambiguities) {
  // Language chip
  els.langName.textContent = lang;
  const ext = LANG_EXT_MAP[lang] || 'txt';
  els.codeFilename.textContent = `extracted_code.${ext}`;

  // Code
  els.codeOutput.innerHTML = highlightedHtml;

  // Ambiguities
  if (ambiguities && ambiguities.length > 0) {
    els.ambigSection.classList.remove('hidden');
    const ambigTitleEl = document.getElementById('ambig-title');
    if (ambigTitleEl) {
      ambigTitleEl.textContent = `${ambiguities.length} low-confidence character${ambiguities.length > 1 ? 's' : ''} detected — check flagged lines below`;
    }

    els.ambigList.innerHTML = ambiguities.map(a => {
      const match = a.match(/line\s*(\d+)[:\s]+'?(.+?)'?\s+could be\s+'?(.+?)'?$/i);
      if (match) {
        const lineNum = match[1];
        const char = match[2];
        const alt = match[3];
        return `
          <li class="ambig-item">
            <span class="ambig-line-badge">Line ${lineNum}</span>
            <span>Character <code class="ambig-code">${escapeHtml(char)}</code> could be <code class="ambig-code">${escapeHtml(alt)}</code></span>
          </li>
        `;
      }
      return `
        <li class="ambig-item">
          <span class="ambig-line-badge">Notice</span>
          <span>${escapeHtml(a)}</span>
        </li>
      `;
    }).join('');
  } else {
    els.ambigSection.classList.add('hidden');
  }

  // Sync to history if signed in
  if (state.authToken && code) {
    fetch('/api/history/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.authToken}` },
      body: JSON.stringify({ codeText: code, lang })
    }).then(r => r.json()).then(d => {
      if (d.history) renderHistory(d.history);
    }).catch(() => {});
  }

  showPanel('result');
}

/* ═══════════════════════════════════════════════
   COPY TO CLIPBOARD
═══════════════════════════════════════════════ */
async function copyCode() {
  try {
    await navigator.clipboard.writeText(state.extractedCode);
    els.copyBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
      Copied!
    `;
    els.copyBtn.style.background = 'linear-gradient(135deg,#059669,#10b981)';
    showToast('Code copied to clipboard!');
    setTimeout(() => {
      els.copyBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        Copy Code
      `;
      els.copyBtn.style.background = '';
    }, 2200);
  } catch {
    // Fallback for older browsers or file:// protocol
    const ta = document.createElement('textarea');
    ta.value = state.extractedCode;
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('Code copied!');
  }
}

/* ═══════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════ */
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function resetToHero() {
  state.uploadedFile = null;
  state.uploadedImg  = null;
  state.uploadedDataURL = null;
  state.croppedDataURL  = null;
  state.extractedCode   = '';

  if (state.autoCropper)  { state.autoCropper.destroy();  state.autoCropper = null; }
  if (state.manualCropper) { state.manualCropper = null; }

  els.fileInput.value = '';
  els.originalCompare.classList.add('hidden');
  els.viewOriginalBtn.textContent = '';
  els.viewOriginalBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
    Original
  `;
  showPanel('hero');
}

/* ═══════════════════════════════════════════════
   EVENT LISTENERS
═══════════════════════════════════════════════ */
function bindEvents() {
  /* ── Mobile nav toggle ── */
  const menuBtn = document.getElementById('menu-toggle-btn');
  const mobileNav = document.getElementById('mobile-nav');
  const mobileNavAuth = document.getElementById('mobile-nav-auth');

  updateMobileNavAuth = function() {
    if (!mobileNavAuth) return;
    if (state.authToken) {
      mobileNavAuth.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 14px;background:var(--card-2);border-radius:var(--r-md)">
          <span style="font-size:13px;color:var(--txt-2);font-weight:500">${state.authEmail || ''}</span>
          <span style="font-size:12px;color:var(--txt-3);font-weight:500">${state.authRemaining !== null ? state.authRemaining + ' left' : '50/day'}</span>
        </div>
        <button class="btn btn-ghost" onclick="document.getElementById('signout-btn').click()" style="font-size:14px">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          Sign out
        </button>`;
    } else {
      mobileNavAuth.innerHTML = `
        <button class="btn btn-primary" onclick="document.getElementById('nav-signin-btn').click()" style="font-size:14px">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
          Sign in / Create account
        </button>`;
    }
  }

  if (menuBtn && mobileNav) {
    menuBtn.addEventListener('click', () => {
      const open = !mobileNav.classList.contains('hidden');
      mobileNav.classList.toggle('hidden', open);
      menuBtn.setAttribute('aria-expanded', String(!open));
      menuBtn.classList.toggle('open', !open); // toggle open class for css animation
      if (!open) updateMobileNavAuth();
    });
    // Close on outside click
    document.addEventListener('click', e => {
      if (!mobileNav.classList.contains('hidden') &&
          !mobileNav.contains(e.target) && !menuBtn.contains(e.target)) {
        mobileNav.classList.add('hidden');
        menuBtn.setAttribute('aria-expanded', 'false');
        menuBtn.classList.remove('open');
      }
    });
    // Close on nav link click
    mobileNav.querySelectorAll('.mobile-nav-link').forEach(link =>
      link.addEventListener('click', () => {
        mobileNav.classList.add('hidden');
        menuBtn.setAttribute('aria-expanded', 'false');
        menuBtn.classList.remove('open');
      })
    );
  }

  /* ── Upload area ── */
  els.uploadArea.addEventListener('click', () => els.fileInput.click());
  els.uploadArea.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.fileInput.click(); }
  });

  els.fileInput.addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) handleFile(f);
  });

  // Ctrl+O shortcut
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'o' && state.panel === 'hero') {
      e.preventDefault();
      els.fileInput.click();
    }
  });

  /* ── Drag & drop ── */
  els.uploadArea.addEventListener('dragenter', e => { e.preventDefault(); els.uploadArea.classList.add('drag-over'); });
  els.uploadArea.addEventListener('dragover',  e => { e.preventDefault(); els.uploadArea.classList.add('drag-over'); });
  els.uploadArea.addEventListener('dragleave', () => els.uploadArea.classList.remove('drag-over'));
  els.uploadArea.addEventListener('drop', e => {
    e.preventDefault();
    els.uploadArea.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  });

  // Also allow dropping anywhere
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f && state.panel === 'hero') handleFile(f);
  });

  /* ── Clipboard paste ── */
  document.addEventListener('paste', e => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          if (state.panel === 'hero') handleFile(file);
          else if (state.panel === 'crop-select' || state.panel === 'auto-crop' || state.panel === 'manual-crop') {
            // Allow repasting to change image
            handleFile(file);
          }
          break;
        }
      }
    }
  });

  /* ── Crop selection ── */
  els.autoCropBtn.addEventListener('click', enterAutoCrop);
  els.autoCropBtn.addEventListener('keydown', e => { if (e.key==='Enter'||e.key===' ') enterAutoCrop(); });

  els.manualCropBtn.addEventListener('click', enterManualCrop);
  els.manualCropBtn.addEventListener('keydown', e => { if (e.key==='Enter'||e.key===' ') enterManualCrop(); });

  els.changeImgBtn.addEventListener('click', () => { els.fileInput.click(); });

  /* ── Auto crop ── */
  els.autoBackBtn.addEventListener('click', () => {
    if (state.autoCropper) { state.autoCropper.destroy(); state.autoCropper = null; }
    showPanel('crop-select');
  });
  els.autoExtractBtn.addEventListener('click', () => {
    if (!state.autoCropper) return;
    const dataURL = state.autoCropper.getCroppedDataURL();
    runExtraction(dataURL);
  });

  /* ── Manual crop ── */
  els.manualBackBtn.addEventListener('click', () => {
    state.manualCropper = null;
    showPanel('crop-select');
  });
  els.manualExtractBtn.addEventListener('click', () => {
    if (!state.manualCropper) return;
    const dataURL = state.manualCropper.getCroppedDataURL();
    if (!dataURL) { showToast('Please draw a selection first.', 'error'); return; }
    runExtraction(dataURL);
  });
  els.zoomInBtn.addEventListener('click',  () => state.manualCropper?.zoomBy(1.3));
  els.zoomOutBtn.addEventListener('click', () => state.manualCropper?.zoomBy(1/1.3));
  els.zoomFitBtn.addEventListener('click', () => { state.manualCropper?.fitImage(); state.manualCropper?.render(); });
  els.manualResetBtn.addEventListener('click', () => state.manualCropper?.resetSel());

  /* ── Result ── */
  els.copyBtn.addEventListener('click', copyCode);

  els.viewOriginalBtn.addEventListener('click', () => {
    const hidden = els.originalCompare.classList.toggle('hidden');
    const icon = hidden
      ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> Original`
      : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg> Hide`;
    els.viewOriginalBtn.innerHTML = icon;
  });

  els.tryAgainBtn.addEventListener('click', () => {
    showPanel('crop-select');
  });

  els.extractAnotherBtn.addEventListener('click', resetToHero);

  /* ── Auth modal ── */
  els.tabSignin.addEventListener('click', () => switchAuthTab('signin'));
  els.tabSignup.addEventListener('click', () => switchAuthTab('signup'));

  els.signinEye.addEventListener('click', () =>
    toggleEye(els.signinPassword, els.signinEyeShow, els.signinEyeHide));
  els.signupEye.addEventListener('click', () =>
    toggleEye(els.signupPassword, els.signupEyeShow, els.signupEyeHide));

  els.signupPassword.addEventListener('input', () => updateStrength(els.signupPassword.value));

  // Submit on Enter
  [els.signinEmail, els.signinPassword].forEach(el =>
    el.addEventListener('keydown', e => { if (e.key === 'Enter') handleSignIn(); }));
  [els.signupEmail, els.signupPassword].forEach(el =>
    el.addEventListener('keydown', e => { if (e.key === 'Enter') handleSignUp(); }));

  els.signinBtn.addEventListener('click', handleSignIn);
  els.signupBtn.addEventListener('click', handleSignUp);

  els.authCancelBtn.addEventListener('click', () => {
    state.pendingExtract = false; closeAuthModal();
  });
  els.authSignupCancelBtn.addEventListener('click', () => {
    state.pendingExtract = false; closeAuthModal();
  });
  els.authModalClose.addEventListener('click', () => {
    state.pendingExtract = false; closeAuthModal();
  });
  els.authModal.addEventListener('click', e => {
    if (e.target === els.authModal) { state.pendingExtract = false; closeAuthModal(); }
  });

  /* ── Nav sign-in / sign-out ── */
  els.navSigninBtn.addEventListener('click', () => openAuthModal({ tab: 'signin' }));
  if (els.heroSigninBtn) {
    els.heroSigninBtn.addEventListener('click', () => openAuthModal({ tab: 'signin' }));
  }
  els.signoutBtn.addEventListener('click', () => {
    clearAuth();
    updateUserPill();
    showToast('Signed out.', 'info');
  });

  /* ── Error modal ── */
  els.errorModalClose.addEventListener('click',  () => closeModal(els.errorModal));
  els.errorModalCancel.addEventListener('click', () => closeModal(els.errorModal));
  els.errorRetryBtn.addEventListener('click', () => {
    closeModal(els.errorModal);
    if (state.croppedDataURL) runExtraction(state.croppedDataURL);
  });

  /* ── Close modals on backdrop click ── */
  [els.authModal, els.errorModal].forEach(modal => {
    if (modal) modal.addEventListener('click', e => {
      if (e.target === modal) closeModal(modal);
    });
  });

  /* ── Close modals on Escape ── */
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      [els.authModal, els.errorModal].forEach(modal => {
        if (modal && !modal.classList.contains('hidden')) closeModal(modal);
      });
    }
  });
}

/* ═══════════════════════════════════════════════
   CROP ENTRY POINTS
═══════════════════════════════════════════════ */
function enterAutoCrop() {
  if (!state.uploadedImg) return;
  // Silent Auto Crop — detect code region, crop offscreen, and extract immediately with 0 clicks
  const dummyCanvas = document.createElement('canvas');
  const cropper = new AutoCropper(dummyCanvas, state.uploadedImg);
  const dataURL = cropper.getCroppedDataURL();
  if (dataURL) {
    runExtraction(dataURL);
  } else {
    runExtraction(state.uploadedDataURL);
  }
}

function enterManualCrop() {
  if (!state.uploadedImg) return;
  showPanel('manual-crop');

  // Update extract button state based on selection
  els.manualExtractBtn.disabled = true;
  els.manualExtractBtn.setAttribute('aria-disabled', 'true');

  requestAnimationFrame(() => {
    state.manualCropper = new ManualCropper(
      els.manualCropCanvas,
      state.uploadedImg,
      (sel) => {
        const hasValid = sel && sel.w > 4 && sel.h > 4;
        els.manualExtractBtn.disabled = !hasValid;
        els.manualExtractBtn.setAttribute('aria-disabled', String(!hasValid));
        els.manualHintLbl.textContent = hasValid
          ? `${Math.round(sel.w)} × ${Math.round(sel.h)} px selected`
          : 'Draw a selection';
      }
    );
  });
}

/* ═══════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════ */
function init() {
  loadAuth();
  bindEvents();
  updateUsageUI();
  updateUserPill();
  showPanel('hero');
  // Verify token with server in the background
  if (state.authToken) {
    refreshAuthState().then(updateUserPill);
  }
  console.log('%c CodeSnapper loaded ❖', 'color:#a78bfa;font-weight:bold;font-size:16px');
}

document.addEventListener('DOMContentLoaded', init);
