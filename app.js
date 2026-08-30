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
const MAX_BATCH_ANON = 5;
const MAX_BATCH_AUTH = 10;

const state = {
  panel:        'hero',        // hero | batch-preview | crop-select | auto-crop | manual-crop | processing | result
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

  // Batch Mode State
  isBatch:       false,        // boolean: true when in multi-image batch mode
  batchItems:    [],           // Array of { id, file, img, dataURL, name, sizeStr, resolution }
  batchResults:  [],           // Array of { id, name, sizeStr, img, dataURL, croppedDataURL, success, error, code, html, lang, ambiguities, raw }
  activeBatchIdx: 0,           // Currently viewed tab index in batch result

  // Auth
  authToken:     null,         // JWT string or null
  authEmail:     null,         // signed-in email
  authRemaining: null,         // extractions remaining this window (number or null)
  authUsed:      null,         // extractions used this window (from server)
  pendingExtract:false,        // true when extraction was queued but auth modal was shown
};

/* ═══════════════════════════════════════════════
   ELEMENT REFS
═══════════════════════════════════════════════ */
const $ = id => document.getElementById(id);

const els = {
  heroPanel:         $('hero-panel'),
  appSection:        $('app-section'),
  batchPreviewPanel: $('batch-preview-panel'),
  cropSelectPanel:   $('crop-select-panel'),
  autoCropPanel:     $('auto-crop-panel'),
  manualCropPanel:   $('manual-crop-panel'),
  processingPanel:   $('processing-panel'),
  resultPanel:       $('result-panel'),

  uploadArea:           $('upload-area'),
  fileInput:            $('file-input'),
  tapToBrowseBtn:       $('tap-to-browse-btn'),
  serverStatusBanner:   $('server-status-banner'),
  serverStatusMsg:      $('server-status-msg'),
  serverStatusRetryBtn: $('server-status-retry-btn'),
  usageText:            $('usage-text'),
  usageCount:           $('usage-count'),
  usageFill:            $('usage-fill'),
  usageProgress:        $('usage-progress'),

  // Batch Preview Elements
  batchCountTitle:      $('batch-count-title'),
  batchLimitWarning:    $('batch-limit-warning'),
  batchLimitWarningMsg: $('batch-limit-warning-msg'),
  batchGrid:            $('batch-grid'),
  batchCancelBtn:       $('batch-cancel-btn'),
  batchAddBtn:          $('batch-add-btn'),
  batchExtractBtn:      $('batch-extract-btn'),
  batchExtractBtnLbl:   $('batch-extract-btn-lbl'),
  batchFooterHint:      $('batch-footer-hint'),

  // Batch Processing & Result Elements
  batchProgressWrap:    $('batch-progress-wrap'),
  batchProgressLabel:   $('batch-progress-label'),
  batchProgressPct:     $('batch-progress-pct'),
  batchProgressFill:    $('batch-progress-fill'),
  batchProcThumb:       $('batch-proc-thumb'),
  batchProcBadge:       $('batch-proc-badge'),
  batchProcName:        $('batch-proc-name'),
  batchTabsBar:         $('batch-tabs-bar'),
  batchTabsList:        $('batch-tabs-list'),
  batchCopyAllBtn:      $('batch-copy-all-btn'),
  batchItemError:       $('batch-item-error'),
  batchItemErrorMsg:    $('batch-item-error-msg'),

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
  manualResetBtn:  $('manual-reset-btn'),
  manualHintLbl:   $('manual-hint-lbl'),

  processingTitle: $('processing-title'),
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
  signupConfirmEye:      $('signup-confirm-eye'),
  signupConfirmEyeShow:  $('signup-confirm-eye-show'),
  signupConfirmEyeHide:  $('signup-confirm-eye-hide'),

  // user pill (header) & hero callout
  navSigninBtn:   $('nav-signin-btn'),
  userPill:       $('user-pill'),
  userPillEmail:  $('user-pill-email'),
  userPillRemaining: $('user-pill-remaining'),
  signoutBtn:     $('signout-btn'),
  heroAuthCallout:$('hero-auth-callout'),
  heroSigninBtn:  $('hero-signin-btn'),

  // extraction history drawer elements
  navHistoryBtn:        $('nav-history-btn'),
  mobileNavHistory:     $('mobile-nav-history'),
  historyDrawerWrap:    $('history-drawer-wrap'),
  historyBackdrop:      $('history-backdrop'),
  historyDrawer:        $('history-drawer'),
  historyCloseBtn:      $('history-close-btn'),
  historyCountBadge:    $('history-count-badge'),
  historyLoading:       $('history-loading'),
  historyEmpty:         $('history-empty'),
  historyList:          $('drawer-history-list') || $('history-list'),

  // Rate Us modal
  rateModal:            $('rate-modal'),
  rateModalClose:       $('rate-modal-close'),
  rateSubmitBtn:        $('rate-submit-btn'),
  rateMaybeLaterBtn:    $('rate-maybe-later-btn'),
  starRatingWrap:       $('star-rating-wrap'),
  rateFeedbackText:     $('rate-feedback-text'),
  rateCharCount:        $('rate-char-count'),

  errorModal:       $('error-modal'),
  errorModalMsg:    $('error-modal-msg'),
  errorModalClose:  $('error-modal-close'),
  errorModalCancel: $('error-modal-cancel'),
  errorRetryBtn:    $('error-retry-btn'),
  errorReportBtn:   $('error-report-btn'),

  // feedback modal
  feedbackModal:        $('feedback-modal'),
  feedbackModalClose:   $('feedback-modal-close'),
  feedbackForm:         $('feedback-form'),
  feedbackType:         $('feedback-type'),
  feedbackDesc:         $('feedback-desc'),
  feedbackCharCount:    $('feedback-char-count'),
  feedbackSubmitBtn:    $('feedback-submit-btn'),
  feedbackCancelBtn:    $('feedback-cancel-btn'),
  reportIssueResultBtn: $('report-issue-result-btn'),
  footerReportLink:     $('footer-report-link'),

  // camera lens modal & tools
  openCameraBtn:        $('open-camera-btn'),
  cameraFileInput:      $('camera-file-input'),
  cameraModal:          $('camera-modal'),
  cameraModalClose:     $('camera-modal-close'),
  cameraSwitchBtn:      $('camera-switch-btn'),
  cameraVideo:          $('camera-video'),
  cameraCanvas:         $('camera-canvas'),
  cameraPreviewImg:     $('camera-preview-img'),
  cameraFramingGuide:   $('camera-framing-guide'),
  cameraErrorView:      $('camera-error-view'),
  cameraErrorMsg:       $('camera-error-msg'),
  cameraRetryBtn:       $('camera-retry-btn'),
  cameraFallbackFileBtn:$('camera-fallback-file-btn'),
  cameraLiveControls:   $('camera-live-controls'),
  cameraCaptureBtn:     $('camera-capture-btn'),
  cameraReviewControls: $('camera-review-controls'),
  cameraRetakeBtn:      $('camera-retake-btn'),
  cameraConfirmBtn:     $('camera-confirm-btn'),
  cameraTipsRow:        $('camera-tips-row'),
  cameraLiveDot:        $('camera-live-dot'),

  toast:    $('toast'),
  toastMsg: $('toast-msg'),

  historySection: $('history-section'),
  historyList:    $('history-list'),
};

/* ═══════════════════════════════════════════════
   STEP MANAGER (MUTUALLY EXCLUSIVE STATES)
═══════════════════════════════════════════════ */
function showPanel(name) {
  state.panel = name;

  // Always restore body & html scrolling
  document.body.style.overflow = '';
  document.documentElement.style.overflow = '';
  document.body.style.position = '';
  document.body.style.touchAction = '';

  const allPanels = [
    { id: 'hero',          el: els.heroPanel },
    { id: 'batch-preview', el: els.batchPreviewPanel },
    { id: 'crop-select',   el: els.cropSelectPanel },
    { id: 'auto-crop',     el: els.autoCropPanel },
    { id: 'manual-crop',   el: els.manualCropPanel },
    { id: 'processing',    el: els.processingPanel },
    { id: 'result',        el: els.resultPanel },
  ];

  // 1. Explicitly hide ALL panels first
  allPanels.forEach(({ el }) => {
    if (!el) return;
    el.classList.add('hidden');
    el.setAttribute('hidden', 'true');
    el.style.display = 'none';
  });

  // 2. Manage parent #app-section container
  const isHero = name === 'hero';
  if (els.appSection) {
    if (isHero) {
      els.appSection.classList.add('hidden');
      els.appSection.setAttribute('hidden', 'true');
      els.appSection.style.display = 'none';
    } else {
      els.appSection.classList.remove('hidden');
      els.appSection.removeAttribute('hidden');
      els.appSection.style.display = '';
    }
  }

  // 3. Show ONLY the active panel
  const active = allPanels.find(p => p.id === name);
  if (active && active.el) {
    active.el.classList.remove('hidden');
    active.el.removeAttribute('hidden');
    active.el.style.display = '';
  }

  // 4. Instant scroll to top
  window.scrollTo(0, 0);
}

/* ═══════════════════════════════════════════════
   AUTH  —  storage, API, UI
═══════════════════════════════════════════════ */
function loadAuth() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_AUTH);
    if (!raw) return;
    const { token, email, remaining, used } = JSON.parse(raw);
    state.authToken     = token     || null;
    state.authEmail     = email     || null;
    state.authRemaining = remaining ?? null;
    state.authUsed      = used      ?? (remaining !== null ? Math.max(0, 50 - remaining) : null);
  } catch { /* corrupt — ignore */ }
}

function saveAuth(token, email, remaining, used = null) {
  state.authToken     = token;
  state.authEmail     = email;
  state.authRemaining = remaining ?? null;
  if (used !== null) state.authUsed = used;
  else if (remaining !== null) state.authUsed = Math.max(0, 50 - remaining);
  localStorage.setItem(STORAGE_KEY_AUTH, JSON.stringify({ token, email, remaining, used: state.authUsed }));
}

function clearAuth() {
  state.authToken = state.authEmail = state.authRemaining = state.authUsed = null;
  localStorage.removeItem(STORAGE_KEY_AUTH);
  updateUsageUI();
}

/* Fetch signed-in user's exact daily usage from server */
async function fetchUserUsage() {
  if (!state.authToken) {
    updateUsageUI();
    return null;
  }
  try {
    const res = await fetch('/api/user/usage', {
      headers: { 'Authorization': `Bearer ${state.authToken}` }
    });
    if (res.ok) {
      const data = await res.json();
      state.authUsed = data.used ?? 0;
      state.authRemaining = data.remaining ?? Math.max(0, 50 - state.authUsed);
      updateUsageUI();
      updateUserPill();
      return data;
    }
  } catch (err) {
    console.warn('[Usage] Could not fetch user usage:', err.message);
  }
  return null;
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
      await fetchUserUsage();
    } else {
      // token expired or account gone
      clearAuth();
    }
  } catch { /* offline — keep cached state */ }
}

/* ─── EXTRACTION HISTORY DRAWER (Signed-in users) ─────────────────────── */
function openHistoryDrawer() {
  if (!state.authToken) {
    openAuthModal({ msg: 'Sign in to view your 90-day extraction history.' });
    return;
  }
  if (els.historyDrawerWrap) {
    els.historyDrawerWrap.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    fetchHistory();
  }
}

function closeHistoryDrawer() {
  if (els.historyDrawerWrap) {
    els.historyDrawerWrap.classList.add('hidden');
    document.body.style.overflow = '';
  }
}

async function fetchHistory() {
  if (!state.authToken) {
    if (els.historyDrawerWrap) els.historyDrawerWrap.classList.add('hidden');
    return;
  }

  const listEl = els.historyList || $('drawer-history-list') || $('history-list');
  if (listEl) listEl.innerHTML = '';
  if (els.historyLoading) els.historyLoading.classList.remove('hidden');
  if (els.historyEmpty) els.historyEmpty.classList.add('hidden');

  try {
    const res = await fetch('/api/history', {
      headers: { 'Authorization': `Bearer ${state.authToken}` }
    });
    if (res.ok) {
      const data = await res.json();
      renderHistory(data.history || []);
    } else {
      if (els.historyEmpty) els.historyEmpty.classList.remove('hidden');
    }
  } catch (err) {
    console.error('[History] Fetch error:', err);
    if (els.historyEmpty) els.historyEmpty.classList.remove('hidden');
  } finally {
    if (els.historyLoading) els.historyLoading.classList.add('hidden');
  }
}

function formatHistoryDate(timestamp) {
  const d = new Date(timestamp);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

function renderHistory(items) {
  window._recentExtractions = items || [];
  const count = (items || []).length;
  if (els.historyCountBadge) els.historyCountBadge.textContent = count;

  const listEl = els.historyList || $('drawer-history-list') || $('history-list');
  if (!items || items.length === 0) {
    if (els.historyEmpty) els.historyEmpty.classList.remove('hidden');
    if (listEl) listEl.innerHTML = '';
    return;
  }

  if (els.historyEmpty) els.historyEmpty.classList.add('hidden');
  if (!listEl) return;

  els.historyList.innerHTML = items.map(item => {
    const rawCode = item.extractedCode || '';
    const previewLines = rawCode.split('\n').slice(0, 3).join('\n');
    const langLabel = (item.language && item.language !== 'auto') ? item.language : 'code';
    const dateStr = formatHistoryDate(item.createdAt);
    const safeName = item.customName || 'Extraction';
    const expiresInStr = (item.expiresInDays !== undefined)
      ? (item.expiresInDays <= 0 ? 'Expires today' : `Expires in ${item.expiresInDays}d`)
      : 'Expires in 90d';

    return `
      <div class="history-card" role="listitem" data-id="${item.id}">
        <div class="history-card-top">
          <div class="history-card-name-wrap">
            <span class="history-card-name" onclick="startRenameHistoryItem(${item.id}, '${escapeHtml(safeName).replace(/'/g, "\\'")}', this.closest('.history-card'))" title="Click to rename">
              ${escapeHtml(safeName)}
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </span>
          </div>
          <span class="history-lang-badge">${escapeHtml(langLabel)}</span>
        </div>

        <div class="history-meta-row">
          <span class="history-date">${dateStr}</span>
          <span>·</span>
          <span class="history-expiry-tag" title="Auto-deletes after 90 days">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            ${expiresInStr}
          </span>
        </div>

        <pre class="history-code-preview"><code>${escapeHtml(previewLines || '(Empty extraction)')}</code></pre>

        <div class="history-card-actions">
          <button class="btn btn-primary btn-sm history-load-btn" onclick="loadHistoryCode(${item.id})">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
            Load Code
          </button>
          <button class="btn btn-ghost btn-sm history-del-btn" onclick="deleteHistoryItem(${item.id}, this.closest('.history-card'))" title="Delete from history">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            Delete
          </button>
        </div>
      </div>
    `;
  }).join('');
}

window.loadHistoryCode = function(id) {
  const item = (window._recentExtractions || []).find(i => i.id === id);
  if (!item) return;

  const rawCode = item.extractedCode || '';
  const { html, lang } = detectAndHighlight(rawCode);
  state.extractedCode = rawCode;
  state.detectedLang  = lang;
  state.ambiguities   = [];
  state.rawResponse   = rawCode;

  displayResult(rawCode, html, lang, []);
  closeHistoryDrawer();
  showToast(`Loaded "${item.customName || 'code'}" from history`);
};

window.startRenameHistoryItem = function(id, currentName, cardEl) {
  if (!cardEl) return;
  const nameWrap = cardEl.querySelector('.history-card-name-wrap');
  if (!nameWrap) return;

  nameWrap.innerHTML = `
    <form class="history-rename-form" onsubmit="return false;">
      <input type="text" class="history-rename-input" value="${escapeHtml(currentName)}" maxlength="60" aria-label="Rename extraction">
      <button type="button" class="btn btn-primary btn-sm history-save-btn" style="padding:4px 8px;font-size:12px">Save</button>
      <button type="button" class="btn btn-ghost btn-sm history-cancel-btn" style="padding:4px 8px;font-size:12px">Cancel</button>
    </form>
  `;

  const input = nameWrap.querySelector('.history-rename-input');
  const saveBtn = nameWrap.querySelector('.history-save-btn');
  const cancelBtn = nameWrap.querySelector('.history-cancel-btn');

  input.focus();
  input.select();

  async function doSave() {
    const newName = input.value.trim();
    if (!newName || newName === currentName) {
      finish(currentName);
      return;
    }
    try {
      const res = await fetch(`/api/history/${id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${state.authToken}`
        },
        body: JSON.stringify({ customName: newName })
      });
      if (res.ok) {
        finish(newName);
        showToast('Renamed extraction');
        if (window._recentExtractions) {
          const it = window._recentExtractions.find(x => x.id === id);
          if (it) it.customName = newName;
        }
      } else {
        showToast('Could not rename extraction');
        finish(currentName);
      }
    } catch {
      showToast('Network error while renaming');
      finish(currentName);
    }
  }

  function finish(finalName) {
    nameWrap.innerHTML = `
      <span class="history-card-name" onclick="startRenameHistoryItem(${id}, '${escapeHtml(finalName).replace(/'/g, "\\'")}', this.closest('.history-card'))" title="Click to rename">
        ${escapeHtml(finalName)}
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </span>
    `;
  }

  saveBtn.addEventListener('click', doSave);
  cancelBtn.addEventListener('click', () => finish(currentName));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); doSave(); }
    if (e.key === 'Escape') { e.preventDefault(); finish(currentName); }
  });
};

window.deleteHistoryItem = async function(id, cardEl) {
  if (!state.authToken) return;
  try {
    const res = await fetch(`/api/history/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${state.authToken}` }
    });
    if (res.ok) {
      if (cardEl) {
        cardEl.style.transition = 'opacity 0.2s, transform 0.2s';
        cardEl.style.opacity = '0';
        cardEl.style.transform = 'translateX(20px)';
        setTimeout(() => {
          cardEl.remove();
          if (window._recentExtractions) {
            window._recentExtractions = window._recentExtractions.filter(x => x.id !== id);
            const count = window._recentExtractions.length;
            if (els.historyCountBadge) els.historyCountBadge.textContent = count;
            if (count === 0 && els.historyEmpty) els.historyEmpty.classList.remove('hidden');
          }
        }, 200);
      }
      showToast('Deleted from history');
    } else {
      showToast('Could not delete history item');
    }
  } catch {
    showToast('Network error while deleting');
  }
};

/* Update the header user pill */
function updateUserPill() {
  const signedIn = !!state.authToken;
  els.navSigninBtn.classList.toggle('hidden', signedIn); // Always visible when signed out!
  els.userPill.classList.toggle('hidden', !signedIn);
  if (els.heroAuthCallout) {
    els.heroAuthCallout.classList.toggle('hidden', signedIn);
  }
  if (els.navHistoryBtn) {
    els.navHistoryBtn.classList.toggle('hidden', !signedIn);
    els.navHistoryBtn.style.display = signedIn ? 'inline-flex' : 'none';
  }
  if (els.mobileNavHistory) {
    els.mobileNavHistory.classList.toggle('hidden', !signedIn);
    els.mobileNavHistory.style.display = signedIn ? 'flex' : 'none';
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
    closeHistoryDrawer();
  }
  // Keep mobile drawer auth section and usage counter in sync
  updateMobileNavAuth();
  updateUsageUI();
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
  const email    = els.signinEmail.value.trim().toLowerCase();
  const password = els.signinPassword.value;
  els.signinError.classList.add('hidden');
  els.signinBtn.disabled = true;
  els.signinBtn.textContent = 'Signing in…';
  try {
    const d = await apiAuth('/api/auth/login', email, password);
    saveAuth(d.token, d.email, d.remaining);
    await fetchUserUsage();
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
  const email       = els.signupEmail.value.trim().toLowerCase();
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
    await fetchUserUsage();
    closeAuthModal();
    updateUserPill();
    showToast(`Account created! Welcome, ${d.email.split('@')[0]} ✨`);
    if (state.pendingExtract) { state.pendingExtract = false; runExtraction(state.croppedDataURL); }
  } catch (e) {
    if (e.message && e.message.includes('already exists')) {
      els.signupError.innerHTML = 'An account with this email already exists — <a href="#" id="signup-to-signin-link" style="color:var(--violet-d);text-decoration:underline;font-weight:600">sign in instead</a>';
      const toSigninLink = document.getElementById('signup-to-signin-link');
      if (toSigninLink) {
        toSigninLink.addEventListener('click', (ev) => {
          ev.preventDefault();
          switchAuthTab('signin');
          if (els.signinEmail) {
            els.signinEmail.value = email;
            if (els.signinPassword) els.signinPassword.focus();
          }
        });
      }
    } else {
      els.signupError.textContent = formatErrorMessage(e.message);
    }
    els.signupError.classList.remove('hidden');
  } finally {
    els.signupBtn.disabled = false;
    els.signupBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg> Create account &amp; continue';
  }
}

/* ═══════════════════════════════════════════════
   USAGE TRACKING & EXTRACTION LIMITS
   Anon: 25 free extractions (no account needed)
   Signed-in: 50 extractions per day (resets every 24h)
═══════════════════════════════════════════════ */
function getCount()  { return parseInt(localStorage.getItem(STORAGE_KEY_CNT) || '0', 10); }
function incCount()  { localStorage.setItem(STORAGE_KEY_CNT, String(getCount() + 1)); }
function isLimited() {
  if (state.authToken) return false; // signed-in: server decides
  return getCount() >= MAX_ANON_EXTRACTIONS;
}

let countdownInterval = null;

function formatCountdown(ms) {
  if (ms <= 0) return '0 minutes';
  const totalMins = Math.ceil(ms / 60000);
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours > 0) {
    return `${hours} hour${hours > 1 ? 's' : ''} ${mins} minute${mins !== 1 ? 's' : ''}`;
  }
  return `${mins} minute${mins !== 1 ? 's' : ''}`;
}

function updateUsageUI() {
  const usageCountEl = document.getElementById('usage-count');
  const usageTextEl  = document.getElementById('usage-text') || (els ? els.usageText : null);
  const usageFill    = document.getElementById('usage-fill') || (els ? els.usageFill : null);
  const usageProg    = document.getElementById('usage-progress') || (els ? els.usageProgress : null);

  if (state.authToken) {
    // Signed-in user: 50 extractions per day
    const limit = 50;
    const used = state.authUsed !== null
      ? state.authUsed
      : (state.authRemaining !== null ? Math.max(0, limit - state.authRemaining) : 0);

    const isDailyLimitReached = (used >= limit) || (state.authRemaining === 0);

    if (isDailyLimitReached) {
      const now = Date.now();
      const resetTime = state.authResetAt || (now + 24 * 60 * 60 * 1000);
      const remainingMs = Math.max(0, resetTime - now);
      const countdownStr = formatCountdown(remainingMs);

      if (usageTextEl) {
        usageTextEl.innerHTML = `<span style="color:#ef4444;font-weight:700">Daily limit reached</span> — resets in ${countdownStr}`;
      }

      if (!countdownInterval) {
        countdownInterval = setInterval(() => {
          if (state.authToken && ((state.authUsed !== null && state.authUsed >= 50) || state.authRemaining === 0)) {
            updateUsageUI();
          } else {
            clearInterval(countdownInterval);
            countdownInterval = null;
          }
        }, 30000);
      }
    } else {
      if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
      }
      if (usageTextEl) {
        usageTextEl.innerHTML = `<span class="count" id="usage-count">${used}</span> / ${limit} extractions per day · Resets every 24 hours`;
      } else if (usageCountEl) {
        usageCountEl.textContent = used;
      }
    }

    const pct = Math.min(100, Math.max(0, (used / limit) * 100));
    if (usageFill) {
      usageFill.style.width = pct + '%';
      if (pct >= 80) {
        usageFill.style.background = '#ef4444'; // Red
      } else if (pct >= 50) {
        usageFill.style.background = '#f59e0b'; // Yellow
      } else {
        usageFill.style.background = '#10b981'; // Green
      }
    }
    if (usageProg) {
      usageProg.setAttribute('aria-valuemax', String(limit));
      usageProg.setAttribute('aria-valuenow', String(used));
    }
  } else {
    // Anonymous user: 25 free extractions — no account needed
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
    const limit = MAX_ANON_EXTRACTIONS || 25;
    const n = getCount();
    const isAnonLimitReached = n >= limit;

    if (isAnonLimitReached) {
      if (usageTextEl) {
        usageTextEl.innerHTML = `You've used all 25 free extractions — <button type="button" class="btn btn-primary btn-xs" onclick="openAuthModal({fromLimit:true})" style="font-size:12px;padding:2px 10px;margin-left:6px;display:inline-flex;vertical-align:middle">Sign in for 50/day</button>`;
      }
    } else {
      if (usageTextEl) {
        usageTextEl.innerHTML = `<span class="count" id="usage-count">${n}</span> / ${limit} free extractions used · No account needed`;
      } else if (usageCountEl) {
        usageCountEl.textContent = n;
      }
    }

    const pct = Math.min(100, Math.max(0, (n / limit) * 100));
    if (usageFill) {
      usageFill.style.width = pct + '%';
      if (pct >= 80) {
        usageFill.style.background = '#ef4444'; // Red
      } else if (pct >= 50) {
        usageFill.style.background = '#f59e0b'; // Yellow
      } else {
        usageFill.style.background = '#10b981'; // Green
      }
    }
    if (usageProg) {
      usageProg.setAttribute('aria-valuemax', String(limit));
      usageProg.setAttribute('aria-valuenow', String(n));
    }
  }
}

/* ═══════════════════════════════════════════════
   MODALS
═══════════════════════════════════════════════ */
function openModal(el)  {
  if (!el) return;
  el.classList.remove('hidden');
  el.removeAttribute('hidden');
  el.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  document.documentElement.style.overflow = 'hidden';
}
function closeModal(el) {
  if (!el) return;
  el.classList.add('hidden');
  el.setAttribute('hidden', 'true');
  el.style.display = 'none';
  document.body.style.overflow = '';
  document.documentElement.style.overflow = '';
  document.body.style.position = '';
  document.body.style.touchAction = '';
}

/* ═══════════════════════════════════════════════
   RATE US PROMPT (After 30th Cumulative Extraction)
═══════════════════════════════════════════════ */
const STORAGE_KEY_CUMULATIVE       = 'cs_cumulative_extractions';
const STORAGE_KEY_HAS_RATED        = 'cs_has_rated';
const STORAGE_KEY_RATING_DISMISSED = 'cs_rating_dismissed_until';

function hasUserRated() {
  return localStorage.getItem(STORAGE_KEY_HAS_RATED) === 'true';
}

function isRatingDismissed() {
  const dismissedUntil = parseInt(localStorage.getItem(STORAGE_KEY_RATING_DISMISSED) || '0', 10);
  return Date.now() < dismissedUntil;
}

function getCumulativeCount() {
  return parseInt(localStorage.getItem(STORAGE_KEY_CUMULATIVE) || '0', 10);
}

function incCumulativeCount() {
  const count = getCumulativeCount() + 1;
  localStorage.setItem(STORAGE_KEY_CUMULATIVE, String(count));
  return count;
}

function checkAndPromptRating(forceCheck = false) {
  if (hasUserRated()) return;
  if (isRatingDismissed()) return;

  if (forceCheck) {
    setTimeout(() => openRateModal(), 1200);
    return;
  }

  const count = incCumulativeCount();
  if (count === 30) {
    setTimeout(() => openRateModal(), 1200);
  }
}

function openRateModal() {
  if (!els.rateModal) return;
  state.selectedRating = 5;
  updateStarsUI(5);
  if (els.rateFeedbackText) els.rateFeedbackText.value = '';
  if (els.rateCharCount) els.rateCharCount.textContent = '0/200';
  openModal(els.rateModal);
}

function closeRateModal() {
  if (!els.rateModal) return;
  closeModal(els.rateModal);
}

function updateStarsUI(starCount) {
  state.selectedRating = starCount;
  const starBtns = document.querySelectorAll('#star-rating-wrap .star-btn');
  starBtns.forEach((btn, idx) => {
    const starNum = idx + 1;
    if (starNum <= starCount) {
      btn.classList.add('selected');
      btn.style.color = '#eab308';
    } else {
      btn.classList.remove('selected');
      btn.style.color = '#475569';
    }
  });
}

async function submitRating() {
  const stars = state.selectedRating || 5;
  const feedback = (els.rateFeedbackText ? els.rateFeedbackText.value : '').trim().slice(0, 200);

  if (els.rateSubmitBtn) {
    els.rateSubmitBtn.disabled = true;
    els.rateSubmitBtn.textContent = 'Submitting…';
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (state.authToken) headers['Authorization'] = `Bearer ${state.authToken}`;

    await fetch('/api/rate', {
      method: 'POST',
      headers,
      body: JSON.stringify({ stars, feedback })
    });

    localStorage.setItem(STORAGE_KEY_HAS_RATED, 'true');
    closeRateModal();
    showToast('Thanks for your feedback! 🎉', 'success');
  } catch (err) {
    console.error('Error submitting rating:', err);
    localStorage.setItem(STORAGE_KEY_HAS_RATED, 'true');
    closeRateModal();
    showToast('Thanks for your feedback! 🎉', 'success');
  } finally {
    if (els.rateSubmitBtn) {
      els.rateSubmitBtn.disabled = false;
      els.rateSubmitBtn.textContent = 'Submit Rating';
    }
  }
}

function dismissRatingFor7Days() {
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  localStorage.setItem(STORAGE_KEY_RATING_DISMISSED, String(Date.now() + sevenDaysMs));
  closeRateModal();
}

/* ═══════════════════════════════════════════════
   ERROR SANITIZATION (Friendly & Non-Technical)
═══════════════════════════════════════════════ */
function formatErrorMessage(err) {
  if (!err) return 'Something went wrong. Please try again.';

  let msg = '';
  if (typeof err === 'string') {
    msg = err;
  } else if (err && typeof err.message === 'string') {
    msg = err.message;
  } else {
    return 'An unexpected error occurred. Please try again or report the issue.';
  }

  // Preserve daily quota messages cleanly
  if (msg.startsWith('DAILY_LIMIT:')) {
    return msg.replace('DAILY_LIMIT:', '').trim();
  }
  if (msg.includes('daily quota of 50') || msg.includes('free extractions without an account')) {
    return msg;
  }
  if (msg.includes('No source code detected') || msg.includes('No code detected')) {
    return 'No source code detected in this screenshot. Please crop closely around the code or try another image.';
  }
  if (msg.includes('Please upload valid image files')) {
    return msg;
  }

  const lower = msg.toLowerCase();

  // Network / server connection failures
  if (
    lower.includes('failed to fetch') ||
    lower.includes('networkerror') ||
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('cannot reach') ||
    lower.includes('pnpm') ||
    lower.includes('offline')
  ) {
    return 'Unable to connect to the service. Please check your internet connection and try again.';
  }

  // Rate limits / high traffic
  if (
    lower.includes('rate_limit') ||
    lower.includes('rate limit') ||
    lower.includes('high traffic') ||
    lower.includes('high demand') ||
    lower.includes('too many requests') ||
    lower.includes('429')
  ) {
    return 'Our service is experiencing high demand right now. Please wait a few seconds and try again.';
  }

  // Timeout errors
  if (
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('took longer than expected') ||
    lower.includes('abort') ||
    lower.includes('504')
  ) {
    return 'Extraction took longer than expected. Please try a tighter crop or check your connection.';
  }

  // Safety / filter blocks
  if (
    lower.includes('safety') ||
    lower.includes('blocked by') ||
    lower.includes('content filter')
  ) {
    return 'This image could not be processed. Please crop closely around the code and try again.';
  }

  // Expired credentials / server internal errors
  if (
    lower.includes('service credentials may have expired') ||
    lower.includes('credentials may have expired') ||
    lower.includes('credentials have expired') ||
    lower.includes('server_key_error') ||
    lower.includes('invalid_api_key') ||
    lower.includes('something went wrong on our end')
  ) {
    return 'Something went wrong on our end. Please try again shortly.';
  }

  // Provider names, API terms, models, credentials, internal errors
  if (
    lower.includes('gemini') ||
    lower.includes('google') ||
    lower.includes('api') ||
    lower.includes('model') ||
    lower.includes('credential') ||
    lower.includes('token') ||
    lower.includes('auth') ||
    lower.includes('server_key_error') ||
    lower.includes('server_config_error') ||
    lower.includes('all_models_failed') ||
    lower.includes('502') ||
    lower.includes('500') ||
    lower.includes('503')
  ) {
    return 'Extraction failed — our service is temporarily unavailable. Please try again in a moment.';
  }

  // Catch raw stack traces, JS exceptions, or object dumps
  if (
    lower.includes('typeerror') ||
    lower.includes('syntaxerror') ||
    lower.includes('referenceerror') ||
    lower.includes('[object') ||
    lower.includes('undefined') ||
    lower.includes('null') ||
    lower.includes('stack') ||
    lower.includes('at ') ||
    lower.includes('{') ||
    lower.includes('}')
  ) {
    return 'An unexpected error occurred. Please try again or report the issue.';
  }

  return msg;
}

function showError(msg, title = 'Extraction failed') {
  const titleEl = document.getElementById('error-modal-title');
  if (titleEl) titleEl.textContent = title;
  const friendlyMsg = formatErrorMessage(msg);
  if (els.errorModalMsg) {
    els.errorModalMsg.textContent = friendlyMsg;
  }
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
    if (!file || !file.type.startsWith('image/')) {
      return reject(new Error('Please upload an image file (PNG, JPG, WEBP, or GIF)'));
    }
    if (file.size > MAX_FILE_SIZE) {
      return reject(new Error('This image is too large — please use an image under 10MB'));
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
   FILE HANDLING (Single & Batch)
═══════════════════════════════════════════════ */
async function handleFiles(fileList) {
  if (!fileList || fileList.length === 0) return;
  const allFiles = Array.from(fileList);

  // 1. Check for non-image files
  const nonImages = allFiles.filter(f => !f.type.startsWith('image/'));
  if (nonImages.length > 0 && allFiles.length === nonImages.length) {
    showError('Please upload an image file (PNG, JPG, WEBP, or GIF)', 'Invalid File Type');
    if (els.fileInput) els.fileInput.value = '';
    return;
  }

  // 2. Check for oversized files (> 10MB)
  const oversized = allFiles.find(f => f.size > MAX_FILE_SIZE);
  if (oversized) {
    showError('This image is too large — please use an image under 10MB', 'Image Too Large');
    if (els.fileInput) els.fileInput.value = '';
    return;
  }

  const files = allFiles.filter(f => f.type.startsWith('image/'));
  if (files.length === 0) {
    showError('Please upload an image file (PNG, JPG, WEBP, or GIF)', 'Invalid File Type');
    if (els.fileInput) els.fileInput.value = '';
    return;
  }

  // Single file and not currently adding to a batch preview
  if (files.length === 1 && (!state.isBatch || state.panel === 'hero')) {
    state.isBatch = false;
    state.batchItems = [];
    state.batchResults = [];
    handleSingleFile(files[0]);
    return;
  }

  // Batch Mode (2 or more files, or adding to an existing batch)
  state.isBatch = true;
  await handleBatchFiles(files);
}

// Single-file backward compatibility
const handleFile = handleFiles;

async function handleSingleFile(file) {
  if (!file) return;
  try {
    const { img, dataURL } = await loadImage(file);
    state.uploadedFile    = file;
    state.uploadedImg     = img;
    state.uploadedDataURL = dataURL;

    // Show single crop selection
    els.cropPreviewImg.src = dataURL;
    els.originalImgDisp.src = dataURL;
    showPanel('crop-select');
  } catch (err) {
    showError(err.message);
  }
}

async function handleBatchFiles(files) {
  const maxAllowed = state.authToken ? MAX_BATCH_AUTH : MAX_BATCH_ANON;
  let targetFiles = files;

  // Check file count against max limit
  const currentCount = state.batchItems.length;
  const availableSlots = maxAllowed - currentCount;

  if (availableSlots <= 0) {
    showToast(
      state.authToken
        ? `Maximum ${MAX_BATCH_AUTH} images allowed in a batch.`
        : `Anonymous users can batch upload up to ${MAX_BATCH_ANON} images. Sign in for up to ${MAX_BATCH_AUTH}.`,
      'error'
    );
    return;
  }

  if (targetFiles.length > availableSlots) {
    showToast(
      state.authToken
        ? `Added first ${availableSlots} images (maximum ${MAX_BATCH_AUTH} per batch).`
        : `Added first ${availableSlots} images (maximum ${MAX_BATCH_ANON} for anonymous users).`,
      'error'
    );
    targetFiles = targetFiles.slice(0, availableSlots);
  }

  // Load each file into batch item object
  for (const file of targetFiles) {
    if (file.size > MAX_FILE_SIZE) {
      showToast(`Skipped "${file.name}" — file is over 10 MB limit.`, 'error');
      continue;
    }
    try {
      const { img, dataURL } = await loadImage(file);
      const sizeStr = (file.size / (1024 * 1024)).toFixed(1) + ' MB';
      const resolution = `${img.naturalWidth} × ${img.naturalHeight}`;
      state.batchItems.push({
        id: 'batch_' + Math.random().toString(36).slice(2, 9),
        file,
        img,
        dataURL,
        name: file.name,
        sizeStr,
        resolution
      });
    } catch (err) {
      showToast(`Failed to load "${file.name}": ${err.message}`, 'error');
    }
  }

  if (state.batchItems.length === 0) {
    resetToHero();
    return;
  }

  renderBatchPreview();
  showPanel('batch-preview');
}

function removeBatchItem(id) {
  state.batchItems = state.batchItems.filter(item => item.id !== id);
  if (state.batchItems.length === 0) {
    resetToHero();
    return;
  }
  renderBatchPreview();
}
window.removeBatchItem = removeBatchItem;

function renderBatchPreview() {
  const count = state.batchItems.length;
  els.batchCountTitle.textContent = count;
  els.batchExtractBtnLbl.textContent = `Extract All (${count} Image${count > 1 ? 's' : ''})`;

  // Calculate upfront remaining quota
  const remaining = state.authToken
    ? (state.authRemaining !== null ? state.authRemaining : 50)
    : Math.max(0, MAX_ANON_EXTRACTIONS - getCount());

  if (remaining < count) {
    els.batchLimitWarning.classList.remove('hidden');
    if (remaining <= 0) {
      els.batchLimitWarningMsg.innerHTML = state.authToken
        ? '<strong>Quota Reached:</strong> You have 0 extractions remaining. Limit resets in 24 hours.'
        : '<strong>Free Limit Reached:</strong> Sign in to get 50 extractions per day.';
      els.batchExtractBtn.disabled = true;
    } else {
      els.batchLimitWarningMsg.innerHTML = `
        <strong>Extraction Limit:</strong> You have <strong>${remaining} extraction${remaining > 1 ? 's' : ''} remaining</strong>. Only the first ${remaining} of ${count} images will be processed.
      `;
      els.batchExtractBtn.disabled = false;
    }
  } else {
    els.batchLimitWarning.classList.add('hidden');
    els.batchExtractBtn.disabled = false;
  }

  // Render thumbnail grid
  els.batchGrid.innerHTML = state.batchItems.map((item, idx) => `
    <div class="batch-card" data-id="${item.id}">
      <div class="batch-thumb-wrap">
        <img class="batch-thumb" src="${item.dataURL}" alt="${escapeHtml(item.name)}">
        <span class="batch-card-badge">#${idx + 1}</span>
        <button class="batch-card-remove" title="Remove screenshot" aria-label="Remove screenshot ${idx + 1}" onclick="removeBatchItem('${item.id}')">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="batch-card-info">
        <div class="batch-card-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
        <div class="batch-card-meta">${item.sizeStr} · ${item.resolution}</div>
      </div>
    </div>
  `).join('');
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
    const parent = this.canvas ? this.canvas.parentElement : null;
    const maxW = (parent ? parent.clientWidth : 800) || 800;
    const maxH = 520;
    const scale = Math.min(maxW / (img.naturalWidth || 1), maxH / (img.naturalHeight || 1), 1);
    if (this.canvas) {
      this.canvas.width  = Math.round((img.naturalWidth || 800) * scale);
      this.canvas.height = Math.round((img.naturalHeight || 600) * scale);
    }
    this.scale = scale; // image px → canvas px

    this.detect();
    if (this.canvas && this.ctx) this.render();

    if (this.canvas && parent) {
      this.canvas.addEventListener('mousedown',  this._onMouseDown);
      window.addEventListener('mousemove', this._onMouseMove);
      window.addEventListener('mouseup',   this._onMouseUp);
      this.canvas.addEventListener('touchstart', this._onTouchStart, { passive: false });
      this.canvas.addEventListener('touchmove',  this._onTouchMove,  { passive: false });
      this.canvas.addEventListener('touchend',   this._onTouchEnd);
    }
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
    if (!this.rect || !this.image) return null;
    const { x, y, w, h } = this.rect;
    if (!w || !h || w < 2 || h < 2) return null;
    const oc = document.createElement('canvas');
    oc.width = w; oc.height = h;
    oc.getContext('2d').drawImage(this.image, x, y, w, h, 0, 0, w, h);
    return oc.toDataURL('image/jpeg', 0.95);
  }

  destroy() {
    if (this.canvas) {
      this.canvas.removeEventListener('mousedown',  this._onMouseDown);
      this.canvas.removeEventListener('touchstart', this._onTouchStart);
      this.canvas.removeEventListener('touchmove',  this._onTouchMove);
      this.canvas.removeEventListener('touchend',   this._onTouchEnd);
    }
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mouseup',   this._onMouseUp);
  }
}

/** Fail-safe helper for silent Auto Crop */
function autoCropImage(img) {
  if (!img || !img.naturalWidth || !img.naturalHeight) return null;
  let dummyCanvas = null;
  let cropper = null;
  try {
    dummyCanvas = document.createElement('canvas');
    cropper = new AutoCropper(dummyCanvas, img);
    const result = cropper.getCroppedDataURL();
    return result;
  } catch (err) {
    console.warn('Auto crop detection fallback to full image:', err);
    return null;
  } finally {
    if (cropper && typeof cropper.destroy === 'function') {
      try { cropper.destroy(); } catch (_) {}
    }
    if (dummyCanvas) {
      dummyCanvas.width = 0;
      dummyCanvas.height = 0;
      dummyCanvas = null;
    }
    cropper = null;
  }
}

/* ═══════════════════════════════════════════════
   MANUAL CROPPER (DRAG-TO-SELECT)
   - Fitted to container width (no zoom / no pan)
   - Drag to draw selection rectangle
   - Semi-transparent overlay with bright border & corner accents
   - High-DPI buffer for ultra-sharp full-resolution view
   - Desktop mouse + Mobile touch with touch-action: none
   - Full original resolution extraction
═══════════════════════════════════════════════ */
class ManualCropper {
  constructor(canvas, image, onSelectionChange) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.image = image;
    this.dpr = Math.max(window.devicePixelRatio || 1, 2);
    this.sel = null; // { x, y, w, h } in NATURAL image coordinates
    this.isDragging = false;
    this.startPoint = null; // { x, y } in CSS canvas px
    this.onSelectionChange = onSelectionChange || (() => {});

    this._onMouseDown  = this._handleMouseDown.bind(this);
    this._onMouseMove  = this._handleMouseMove.bind(this);
    this._onMouseUp    = this._handleMouseUp.bind(this);
    this._onTouchStart = this._handleTouchStart.bind(this);
    this._onTouchMove  = this._handleTouchMove.bind(this);
    this._onTouchEnd   = this._handleTouchEnd.bind(this);

    this._initCanvas();
    this._bindEvents();
  }

  _initCanvas() {
    const parent = this.canvas.parentElement;
    const parentW = parent ? parent.getBoundingClientRect().width : 800;
    const cssW = Math.max(280, parentW || 800);

    const imgW = this.image.naturalWidth || 800;
    const imgH = this.image.naturalHeight || 600;
    const aspect = imgH / imgW;

    // Set display height proportional to aspect ratio
    const cssH = Math.round(cssW * aspect);

    this.cssW = cssW;
    this.cssH = cssH;
    this.scale = cssW / imgW; // 1 CSS px = (1 / scale) image px

    // High-DPI buffer configuration for crystal-clear render
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;

    this.render();
  }

  _bindEvents() {
    this.canvas.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mouseup', this._onMouseUp);

    this.canvas.addEventListener('touchstart', this._onTouchStart, { passive: false });
    this.canvas.addEventListener('touchmove', this._onTouchMove, { passive: false });
    this.canvas.addEventListener('touchend', this._onTouchEnd, { passive: false });
  }

  _getPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    const clientX = e.touches && e.touches.length > 0 ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches && e.touches.length > 0 ? e.touches[0].clientY : e.clientY;
    return {
      x: Math.max(0, Math.min(this.cssW, clientX - rect.left)),
      y: Math.max(0, Math.min(this.cssH, clientY - rect.top))
    };
  }

  _handleMouseDown(e) {
    if (e.button !== 0) return; // Left click only
    const pos = this._getPos(e);
    this.isDragging = true;
    this.startPoint = pos;
    this.sel = null;
    this.render();
    this.onSelectionChange(null);
  }

  _handleMouseMove(e) {
    if (!this.isDragging || !this.startPoint) return;
    const pos = this._getPos(e);

    const minX = Math.min(this.startPoint.x, pos.x);
    const minY = Math.min(this.startPoint.y, pos.y);
    const width = Math.abs(pos.x - this.startPoint.x);
    const height = Math.abs(pos.y - this.startPoint.y);

    // Convert CSS px to natural image px
    this.sel = {
      x: Math.round(minX / this.scale),
      y: Math.round(minY / this.scale),
      w: Math.round(width / this.scale),
      h: Math.round(height / this.scale)
    };

    this.render();
    this.onSelectionChange(this.sel);
  }

  _handleMouseUp() {
    if (!this.isDragging) return;
    this.isDragging = false;
    // Require minimum selection of 8x8 px
    if (this.sel && (this.sel.w < 8 || this.sel.h < 8)) {
      this.sel = null;
    }
    this.render();
    this.onSelectionChange(this.sel);
  }

  _handleTouchStart(e) {
    e.preventDefault();
    const pos = this._getPos(e);
    this.isDragging = true;
    this.startPoint = pos;
    this.sel = null;
    this.render();
    this.onSelectionChange(null);
  }

  _handleTouchMove(e) {
    if (!this.isDragging || !this.startPoint) return;
    e.preventDefault();
    const pos = this._getPos(e);

    const minX = Math.min(this.startPoint.x, pos.x);
    const minY = Math.min(this.startPoint.y, pos.y);
    const width = Math.abs(pos.x - this.startPoint.x);
    const height = Math.abs(pos.y - this.startPoint.y);

    this.sel = {
      x: Math.round(minX / this.scale),
      y: Math.round(minY / this.scale),
      w: Math.round(width / this.scale),
      h: Math.round(height / this.scale)
    };

    this.render();
    this.onSelectionChange(this.sel);
  }

  _handleTouchEnd(e) {
    e.preventDefault();
    this._handleMouseUp();
  }

  resetSel() {
    this.sel = null;
    this.isDragging = false;
    this.startPoint = null;
    this.render();
    this.onSelectionChange(null);
  }

  render() {
    const ctx = this.ctx;
    const dpr = this.dpr;
    const cw = this.canvas.width;
    const ch = this.canvas.height;

    ctx.save();
    ctx.clearRect(0, 0, cw, ch);
    ctx.scale(dpr, dpr);

    // 1. Draw full image fitted to canvas
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.image, 0, 0, this.cssW, this.cssH);

    // 2. If no selection, draw clean uncropped view
    if (!this.sel || this.sel.w < 2 || this.sel.h < 2) {
      ctx.restore();
      return;
    }

    const sx = this.sel.x * this.scale;
    const sy = this.sel.y * this.scale;
    const sw = this.sel.w * this.scale;
    const sh = this.sel.h * this.scale;

    // 3. Dark dim overlay outside selection
    ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
    ctx.fillRect(0, 0, this.cssW, this.cssH);

    // 4. Bright clear un-dimmed image inside selection
    ctx.drawImage(
      this.image,
      this.sel.x, this.sel.y, this.sel.w, this.sel.h,
      sx, sy, sw, sh
    );

    // 5. Bright selection box border
    ctx.strokeStyle = '#a78bfa';
    ctx.lineWidth = 2;
    ctx.strokeRect(sx, sy, sw, sh);

    // 6. Modern corner brackets
    const cLen = Math.min(18, Math.min(sw, sh) / 3);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    // Top-Left
    ctx.moveTo(sx, sy + cLen); ctx.lineTo(sx, sy); ctx.lineTo(sx + cLen, sy);
    // Top-Right
    ctx.moveTo(sx + sw - cLen, sy); ctx.lineTo(sx + sw, sy); ctx.lineTo(sx + sw, sy + cLen);
    // Bottom-Left
    ctx.moveTo(sx, sy + sh - cLen); ctx.lineTo(sx, sy + sh); ctx.lineTo(sx + cLen, sy + sh);
    // Bottom-Right
    ctx.moveTo(sx + sw - cLen, sy + sh); ctx.lineTo(sx + sw, sy + sh); ctx.lineTo(sx + sw, sy + sh - cLen);
    ctx.stroke();

    // 7. Dimension indicator pill badge
    const badgeText = `${this.sel.w} × ${this.sel.h} px`;
    ctx.font = '600 12px "JetBrains Mono", monospace';
    const textW = ctx.measureText(badgeText).width;
    const badgeW = textW + 16;
    const badgeH = 22;
    const badgeX = Math.max(6, Math.min(this.cssW - badgeW - 6, sx + (sw - badgeW) / 2));
    const badgeY = sy > 28 ? sy - badgeH - 6 : sy + sh + 6;

    ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.beginPath();
    ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 6);
    ctx.fill();
    ctx.strokeStyle = 'rgba(167, 139, 250, 0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = '#f1f5f9';
    ctx.fillText(badgeText, badgeX + 8, badgeY + 15);

    ctx.restore();
  }

  getCroppedDataURL() {
    if (!this.sel || this.sel.w < 2 || this.sel.h < 2) return null;
    const { x, y, w, h } = this.sel;
    const oc = document.createElement('canvas');
    oc.width = Math.round(w);
    oc.height = Math.round(h);
    const ctx = oc.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      this.image,
      Math.round(x), Math.round(y), Math.round(w), Math.round(h),
      0, 0, Math.round(w), Math.round(h)
    );
    return oc.toDataURL('image/jpeg', 0.98);
  }

  destroy() {
    this.canvas.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mouseup', this._onMouseUp);

    this.canvas.removeEventListener('touchstart', this._onTouchStart);
    this.canvas.removeEventListener('touchmove', this._onTouchMove);
    this.canvas.removeEventListener('touchend', this._onTouchEnd);
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
      throw new Error('Our service is experiencing high demand right now. Please wait a few seconds and try again.');
    }
    if (resp.status === 401 || code === 'INVALID_API_KEY') {
      throw new Error('Something went wrong on our end. Please try again shortly.');
    }
    if (resp.status === 504 || code === 'IMAGE_TIMEOUT') {
      throw new Error('Extraction took longer than expected. Please try a tighter crop or check your connection.');
    }
    if (resp.status === 502 || code === 'ALL_MODELS_FAILED') {
      throw new Error('Extraction failed — our service is temporarily unavailable. Please try again in a moment.');
    }
    if (resp.status === 500 || code === 'SERVER_CONFIG_ERROR') {
      throw new Error('Something went wrong on our end. Please try again shortly.');
    }
    if (code === 'SAFETY_BLOCK') {
      throw new Error('This image could not be processed. Please crop closely around the code and try again.');
    }
    throw new Error(formatErrorMessage(msg || 'Extraction failed — our service is temporarily unavailable. Please try again in a moment.'));
  }

  // Update remaining count from server response (for signed-in users)
  if (data.remaining !== undefined) {
    state.authRemaining = data.remaining;
    updateUserPill();
  }

  // Trigger Rate Us prompt if 30th extraction reached
  if (data.shouldPromptRating) {
    checkAndPromptRating(true);
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
    setStep(1, true); setStep(2);

    // Step 2: server-side extraction call with active status updates
    els.procStatusText.textContent = 'Transcribing code with Vision AI…';

    const extractStartTime = Date.now();
    const statusUpdates = [
      'Extracting code layout & characters…',
      'Transcribing syntax & line structures…',
      'Finalizing AI vision model output…'
    ];
    let updateIdx = 0;
    statusTicker = setInterval(() => {
      const elapsed = Date.now() - extractStartTime;
      if (elapsed > 4000 && updateIdx === 0) {
        els.procStatusText.textContent = 'Warming up... please wait a moment';
      } else if (updateIdx < statusUpdates.length) {
        els.procStatusText.textContent = statusUpdates[updateIdx++];
      }
    }, 1200);

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
        throw new Error('Our service is experiencing high demand right now. Please wait a few seconds and try again.');
      }
      if (err.message === 'SERVER_CONFIG_ERROR' || err.message === 'SERVER_KEY_ERROR') {
        throw new Error('Something went wrong on our end. Please try again shortly.');
      }
      if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError') || err.name === 'TypeError') {
        throw new Error('Unable to connect to the service. Please check your internet connection and try again.');
      }
      throw new Error(formatErrorMessage(err));
    } finally {
      if (statusTicker) clearInterval(statusTicker);
    }

    setStep(2, true); setStep(3);

    // Step 3: Parse
    els.procStatusText.textContent = 'Parsing code structure & ambiguities…';
    const parsed = parseResponse(raw);

    if (parsed.noCode) {
      setStep(3, true); setStep(4);
      showPanel('crop-select');
      showError('No source code detected in this image. Please upload an image containing source code.', 'No Code Detected');
      return;
    }

    setStep(3, true); setStep(4);
    els.procStatusText.textContent = 'Detecting language & highlighting syntax…';

    // Step 4: Highlight
    const { html, lang } = detectAndHighlight(parsed.code);
    setStep(4, true);

    // Increment counter (anon in localStorage, signed-in synced with server)
    if (!state.authToken) {
      incCount();
      updateUsageUI();
      checkAndPromptRating();
    } else {
      if (state.authUsed !== null) state.authUsed++;
      updateUsageUI();
      fetchUserUsage();
    }

    // Show result
    state.extractedCode = parsed.code;
    state.detectedLang  = lang;
    state.ambiguities   = parsed.ambiguities;
    state.rawResponse   = raw;

    displayResult(parsed.code, html, lang, parsed.ambiguities);
  } catch (err) {
    if (statusTicker) clearInterval(statusTicker);
    showPanel('crop-select');
    const msg = formatErrorMessage(err);
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
   BATCH EXTRACTION PIPELINE (Sequential)
═══════════════════════════════════════════════ */
async function runBatchExtraction() {
  const count = state.batchItems.length;
  if (count === 0) return;

  const remaining = state.authToken
    ? (state.authRemaining !== null ? state.authRemaining : 50)
    : Math.max(0, MAX_ANON_EXTRACTIONS - getCount());

  if (remaining <= 0) {
    if (state.authToken) {
      showError('You have reached your daily quota of 50 extractions. Please wait until your quota resets in 24 hours.', 'Daily Quota Reached');
    } else {
      openAuthModal({ fromLimit: true });
    }
    return;
  }

  const itemsToProcess = state.batchItems.slice(0, remaining);
  const total = itemsToProcess.length;

  state.batchResults = [];
  showPanel('processing');
  els.batchProgressWrap.classList.remove('hidden');
  els.processingTitle.textContent = `Extracting batch (${total} screenshots)…`;

  for (let i = 0; i < total; i++) {
    const item = itemsToProcess[i];
    const num = i + 1;
    const progressPct = Math.round(((i) / total) * 100);

    // 2-second delay between sequential batch images to prevent hitting rate limits
    if (i > 0) {
      if (els.batchProgressLabel) els.batchProgressLabel.textContent = 'Pacing next extraction (2s)…';
      await delay(2000);
    }

    if (els.batchProcThumb) els.batchProcThumb.src = item.dataURL;
    if (els.batchProcBadge) els.batchProcBadge.textContent = `Image ${num} of ${total}`;
    if (els.batchProcName) els.batchProcName.textContent = `${item.name} (${item.sizeStr})`;
    if (els.batchProgressLabel) els.batchProgressLabel.textContent = 'AI Auto-Cropping code area…';
    if (els.batchProgressPct) els.batchProgressPct.textContent = `${progressPct}%`;
    if (els.batchProgressFill) els.batchProgressFill.style.width = `${progressPct}%`;

    resetSteps();
    setStep(1);
    els.procStatusText.textContent = `Processing image ${num} of ${total} · AI Auto Crop`;

    try {
      // 1. Instant AI Auto Crop
      const croppedDataURL = autoCropImage(item.img) || item.dataURL;
      setStep(1, true); setStep(2);
      if (els.batchProgressLabel) els.batchProgressLabel.textContent = 'Transcribing source code…';
      els.procStatusText.textContent = `Processing image ${num} of ${total} · Vision AI`;

      // 2. Call Gemini API with automatic 1-time retry after 3s wait on failure
      let raw;
      try {
        raw = await callGemini(croppedDataURL);
      } catch (firstErr) {
        if (firstErr.message.startsWith('DAILY_LIMIT:') || firstErr.message === 'ANON_LIMIT_REACHED') {
          throw firstErr;
        }
        console.warn(`[Batch] Image ${num} attempt 1 failed (${firstErr.message}). Waiting 3s to retry…`);
        if (els.batchProgressLabel) els.batchProgressLabel.textContent = 'Temporary issue — retrying in 3s…';
        els.procStatusText.textContent = `Retrying image ${num} of ${total} after 3s…`;
        await delay(3000);
        if (els.batchProgressLabel) els.batchProgressLabel.textContent = 'Transcribing source code (Retry)…';
        els.procStatusText.textContent = `Processing image ${num} of ${total} · Vision AI (Retry)`;
        raw = await callGemini(croppedDataURL);
      }

      setStep(2, true); setStep(3);
      if (els.batchProgressLabel) els.batchProgressLabel.textContent = 'Detecting syntax & highlighting…';
      els.procStatusText.textContent = `Processing image ${num} of ${total} · Syntax Highlighting`;

      // 3. Parse Response
      const parsed = parseResponse(raw);
      if (parsed.noCode) {
        state.batchResults.push({
          id: item.id,
          name: item.name,
          sizeStr: item.sizeStr,
          img: item.img,
          dataURL: item.dataURL,
          croppedDataURL,
          success: false,
          error: 'No source code was detected in this screenshot.',
          code: '',
          html: '',
          lang: 'plaintext',
          ambiguities: []
        });
      } else {
        const { html, lang } = detectAndHighlight(parsed.code);
        state.batchResults.push({
          id: item.id,
          name: item.name,
          sizeStr: item.sizeStr,
          img: item.img,
          dataURL: item.dataURL,
          croppedDataURL,
          success: true,
          code: parsed.code,
          html,
          lang,
          ambiguities: parsed.ambiguities,
          raw
        });

        // Save to history if signed in
        if (state.authToken && parsed.code) {
          fetch('/api/history/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.authToken}` },
            body: JSON.stringify({ codeText: parsed.code, lang })
          }).then(r => r.json()).then(d => {
            if (d.history) renderHistory(d.history);
          }).catch(() => {});
        }
      }

      // Count extraction
      if (!state.authToken) {
        incCount();
        updateUsageUI();
        checkAndPromptRating();
      } else {
        if (state.authUsed !== null) state.authUsed++;
        updateUsageUI();
      }
    } catch (err) {
      // Record failure for this specific item and continue batch
      state.batchResults.push({
        id: item.id,
        name: item.name,
        sizeStr: item.sizeStr,
        img: item.img,
        dataURL: item.dataURL,
        croppedDataURL: item.dataURL,
        success: false,
        error: formatErrorMessage(err) || 'Extraction failed for this image.',
        code: '',
        html: '',
        lang: 'plaintext',
        ambiguities: []
      });

      if (err.message.startsWith('DAILY_LIMIT:') || err.message === 'ANON_LIMIT_REACHED') {
        break;
      }
    }
  }

  els.batchProgressPct.textContent = '100%';
  els.batchProgressFill.style.width = '100%';

  if (state.authToken) {
    fetchUserUsage();
  }

  showBatchResults();
}

/* ═══════════════════════════════════════════════
   BATCH RESULTS DISPLAY & ACTIONS
═══════════════════════════════════════════════ */
function showBatchResults() {
  if (state.batchResults.length === 0) {
    resetToHero();
    return;
  }

  els.batchTabsBar.classList.remove('hidden');

  // Build Tab Strip
  els.batchTabsList.innerHTML = state.batchResults.map((res, idx) => `
    <button class="batch-tab ${idx === 0 ? 'active' : ''}" data-idx="${idx}" aria-label="View results for Image ${idx + 1}">
      <span>Image ${idx + 1}</span>
      <span class="batch-tab-badge ${res.success ? 'ok' : 'err'}">${res.success ? '✓ ' + res.lang : '✕ Failed'}</span>
    </button>
  `).join('');

  // Wire Tab Clicks
  els.batchTabsList.querySelectorAll('.batch-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-idx'), 10);
      switchBatchTab(idx);
    });
  });

  // Switch to first tab
  switchBatchTab(0);
  showPanel('result');
}

function switchBatchTab(idx) {
  state.activeBatchIdx = idx;

  // Update tab styles
  const allTabs = els.batchTabsList.querySelectorAll('.batch-tab');
  allTabs.forEach((tab, i) => {
    if (i === idx) tab.classList.add('active');
    else tab.classList.remove('active');
  });

  const cur = state.batchResults[idx];
  if (!cur) return;

  // Update original preview image source
  els.originalImgDisp.src = cur.dataURL;

  const codeWin = document.getElementById('code-window');

  if (cur.success) {
    els.batchItemError.classList.add('hidden');
    if (codeWin) codeWin.classList.remove('hidden');
    els.copyBtn.classList.remove('hidden');
    els.viewOriginalBtn.classList.remove('hidden');

    state.extractedCode = cur.code;
    state.detectedLang  = cur.lang;
    state.ambiguities   = cur.ambiguities;
    state.rawResponse   = cur.raw;

    displayResult(cur.code, cur.html, cur.lang, cur.ambiguities);
  } else {
    els.batchItemError.classList.remove('hidden');
    els.batchItemErrorMsg.textContent = cur.error || 'Failed to extract code from this image.';
    if (codeWin) codeWin.classList.add('hidden');
    els.copyBtn.classList.add('hidden');
    els.ambigSection.classList.add('hidden');

    state.extractedCode = '';
    state.detectedLang  = 'plaintext';
    state.ambiguities   = [];

    els.langName.textContent = 'failed';
    els.codeFilename.textContent = cur.name || 'image_error';
  }
}

async function copyAllBatchCode() {
  const successful = state.batchResults.filter(r => r.success && r.code);
  if (successful.length === 0) {
    showToast('No successfully extracted code to copy.', 'error');
    return;
  }

  const combined = successful
    .map((r, i) => `# ---- Image ${i + 1}: ${r.name} (${r.lang}) ---- #\n\n${r.code}`)
    .join('\n\n\n');

  try {
    await navigator.clipboard.writeText(combined);
    els.batchCopyAllBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
      All Copied!
    `;
    els.batchCopyAllBtn.style.background = 'linear-gradient(135deg,#059669,#10b981)';
    showToast(`Copied ${successful.length} code blocks to clipboard!`);
    setTimeout(() => {
      els.batchCopyAllBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        Copy All
      `;
      els.batchCopyAllBtn.style.background = '';
    }, 2200);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = combined;
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast(`Copied ${successful.length} code blocks!`);
  }
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
   CAMERA / LENS VIEWFINDER
═══════════════════════════════════════════════ */
let cameraStream = null;
let cameraFacingMode = 'environment';
let capturedBlob = null;
let hasMultipleVideoDevices = false;

async function checkVideoDevices() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = devices.filter(d => d.kind === 'videoinput');
    hasMultipleVideoDevices = videoInputs.length > 1;
    if (els.cameraSwitchBtn) {
      els.cameraSwitchBtn.style.display = hasMultipleVideoDevices ? 'flex' : 'none';
    }
  } catch {
    hasMultipleVideoDevices = false;
  }
}

async function startCamera(facing = 'environment') {
  cameraFacingMode = facing;
  stopCameraStream();

  // Reset UI states
  if (els.cameraVideo) {
    els.cameraVideo.classList.remove('hidden');
    els.cameraVideo.style.display = 'block';
  }
  if (els.cameraCanvas) {
    els.cameraCanvas.classList.add('hidden');
  }
  if (els.cameraPreviewImg) {
    els.cameraPreviewImg.classList.add('hidden');
    els.cameraPreviewImg.src = '';
  }
  if (els.cameraFramingGuide) {
    els.cameraFramingGuide.classList.remove('hidden');
    els.cameraFramingGuide.style.display = 'flex';
  }
  if (els.cameraErrorView) {
    els.cameraErrorView.classList.add('hidden');
  }
  if (els.cameraLiveControls) {
    els.cameraLiveControls.classList.remove('hidden');
    els.cameraLiveControls.style.display = 'flex';
  }
  if (els.cameraReviewControls) {
    els.cameraReviewControls.classList.add('hidden');
    els.cameraReviewControls.style.display = 'none';
  }
  if (els.cameraTipsRow) {
    els.cameraTipsRow.classList.remove('hidden');
  }
  if (els.cameraLiveDot) {
    els.cameraLiveDot.style.display = 'block';
  }

  openModal(els.cameraModal);

  // Check getUserMedia support
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    console.warn('[Camera] getUserMedia not supported on this browser/context — triggering native capture fallback');
    if (els.cameraFileInput) {
      closeCameraModal();
      els.cameraFileInput.click();
      return;
    }
    showCameraError('Camera API is not supported in this browser. Please upload or browse an image file.');
    return;
  }

  try {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: cameraFacingMode },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: false
      });
    } catch (e1) {
      console.warn('[Camera] Ideal constraints failed, trying basic video constraint:', e1);
      stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false
      });
    }

    cameraStream = stream;
    if (els.cameraVideo) {
      els.cameraVideo.srcObject = stream;
      await els.cameraVideo.play().catch(() => {});
    }

    await checkVideoDevices();
  } catch (err) {
    console.error('[Camera] Access error:', err);
    const isDenied = err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError';
    const msg = isDenied
      ? 'Camera access denied — please allow camera permission in your browser settings, or choose an image file.'
      : (err.message || 'Could not start camera stream. Please try again or upload an image file.');
    showCameraError(msg);
  }
}

function showCameraError(msg) {
  if (els.cameraErrorMsg) els.cameraErrorMsg.textContent = msg;
  if (els.cameraErrorView) els.cameraErrorView.classList.remove('hidden');
  if (els.cameraFramingGuide) els.cameraFramingGuide.style.display = 'none';
  if (els.cameraLiveControls) els.cameraLiveControls.style.display = 'none';
  if (els.cameraReviewControls) els.cameraReviewControls.style.display = 'none';
  if (els.cameraLiveDot) els.cameraLiveDot.style.display = 'none';
}

function stopCameraStream() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(track => {
      try { track.stop(); } catch (_) {}
    });
    cameraStream = null;
  }
  if (els.cameraVideo) {
    els.cameraVideo.srcObject = null;
  }
}

function closeCameraModal() {
  stopCameraStream();
  capturedBlob = null;
  closeModal(els.cameraModal);
}

function switchCamera() {
  cameraFacingMode = (cameraFacingMode === 'environment') ? 'user' : 'environment';
  startCamera(cameraFacingMode);
}

function capturePhoto() {
  if (!els.cameraVideo || !els.cameraVideo.videoWidth) {
    showToast('Waiting for camera stream…', 'error');
    return;
  }

  const vWidth = els.cameraVideo.videoWidth;
  const vHeight = els.cameraVideo.videoHeight;

  const canvas = els.cameraCanvas || document.createElement('canvas');
  canvas.width = vWidth;
  canvas.height = vHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(els.cameraVideo, 0, 0, vWidth, vHeight);

  canvas.toBlob(blob => {
    if (!blob) {
      showToast('Could not capture frame. Please try again.', 'error');
      return;
    }
    capturedBlob = blob;
    const previewUrl = URL.createObjectURL(blob);

    if (els.cameraPreviewImg) {
      els.cameraPreviewImg.src = previewUrl;
      els.cameraPreviewImg.classList.remove('hidden');
    }
    if (els.cameraVideo) {
      els.cameraVideo.style.display = 'none';
    }
    if (els.cameraFramingGuide) {
      els.cameraFramingGuide.style.display = 'none';
    }
    if (els.cameraLiveControls) {
      els.cameraLiveControls.style.display = 'none';
    }
    if (els.cameraReviewControls) {
      els.cameraReviewControls.classList.remove('hidden');
      els.cameraReviewControls.style.display = 'flex';
    }
    if (els.cameraLiveDot) {
      els.cameraLiveDot.style.display = 'none';
    }
  }, 'image/png', 0.95);
}

function retakePhoto() {
  capturedBlob = null;
  if (els.cameraPreviewImg) {
    els.cameraPreviewImg.classList.add('hidden');
    els.cameraPreviewImg.src = '';
  }
  if (els.cameraVideo) {
    els.cameraVideo.style.display = 'block';
  }
  if (els.cameraFramingGuide) {
    els.cameraFramingGuide.style.display = 'flex';
  }
  if (els.cameraLiveControls) {
    els.cameraLiveControls.style.display = 'flex';
  }
  if (els.cameraReviewControls) {
    els.cameraReviewControls.style.display = 'none';
  }
  if (els.cameraLiveDot) {
    els.cameraLiveDot.style.display = 'block';
  }
}

async function confirmPhoto() {
  if (!capturedBlob) return;
  const file = new File([capturedBlob], `camera_snap_${Date.now()}.png`, { type: 'image/png' });
  closeCameraModal();
  await handleFiles([file]);
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
  state.isBatch         = false;
  state.batchItems      = [];
  state.batchResults    = [];
  state.activeBatchIdx  = 0;

  if (state.autoCropper)  { state.autoCropper.destroy();  state.autoCropper = null; }
  if (state.manualCropper) { state.manualCropper = null; }

  els.fileInput.value = '';
  els.batchProgressWrap?.classList.add('hidden');
  els.batchTabsBar?.classList.add('hidden');
  els.batchItemError?.classList.add('hidden');
  document.getElementById('code-window')?.classList.remove('hidden');
  els.copyBtn?.classList.remove('hidden');
  els.processingTitle.textContent = 'Extracting your code…';

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
  els.uploadArea.addEventListener('click', e => {
    // If the click originated from or inside the camera button, don't open the standard file input
    if (e.target.closest('#open-camera-btn')) return;
    els.fileInput.click();
  });
  if (els.tapToBrowseBtn) {
    els.tapToBrowseBtn.addEventListener('click', e => {
      e.stopPropagation();
      e.preventDefault();
      els.fileInput.click();
    });
  }
  els.uploadArea.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      if (e.target.closest('#open-camera-btn')) return;
      e.preventDefault();
      els.fileInput.click();
    }
  });

  /* ── Camera Lens Actions ── */
  function isMobilePlatform() {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
      (window.matchMedia && window.matchMedia('(max-width: 768px)').matches && ('ontouchstart' in window || navigator.maxTouchPoints > 0));
  }

  if (els.openCameraBtn) {
    els.openCameraBtn.addEventListener('click', e => {
      if (e.target === els.cameraFileInput) return;
      if (!isMobilePlatform()) {
        // On desktop browsers with webcam, open the live camera viewfinder modal
        e.preventDefault();
        startCamera('environment');
      }
      // On mobile devices, native <label for="camera-file-input"> triggers the capture="environment" input directly
    });
    els.openCameraBtn.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (isMobilePlatform() && els.cameraFileInput) {
          els.cameraFileInput.click();
        } else {
          startCamera('environment');
        }
      }
    });
  }
  if (els.cameraModalClose) {
    els.cameraModalClose.addEventListener('click', closeCameraModal);
  }
  if (els.cameraModal) {
    els.cameraModal.addEventListener('click', e => {
      if (e.target === els.cameraModal) closeCameraModal();
    });
  }
  if (els.cameraSwitchBtn) {
    els.cameraSwitchBtn.addEventListener('click', switchCamera);
  }
  if (els.cameraCaptureBtn) {
    els.cameraCaptureBtn.addEventListener('click', capturePhoto);
  }
  if (els.cameraRetakeBtn) {
    els.cameraRetakeBtn.addEventListener('click', retakePhoto);
  }
  if (els.cameraConfirmBtn) {
    els.cameraConfirmBtn.addEventListener('click', confirmPhoto);
  }
  if (els.cameraRetryBtn) {
    els.cameraRetryBtn.addEventListener('click', () => startCamera(cameraFacingMode));
  }
  if (els.cameraFallbackFileBtn) {
    els.cameraFallbackFileBtn.addEventListener('click', () => {
      closeCameraModal();
      els.fileInput.click();
    });
  }
  if (els.cameraFileInput) {
    els.cameraFileInput.addEventListener('change', e => {
      if (e.target.files && e.target.files.length > 0) {
        handleFiles(e.target.files);
      }
    });
  }

  els.fileInput.addEventListener('change', e => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(e.target.files);
    }
  });

  // Global Keyboard Shortcuts
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'o' && state.panel === 'hero') {
      e.preventDefault();
      els.fileInput.click();
    }
    if (e.key === 'Escape') {
      if (els.cameraModal && !els.cameraModal.classList.contains('hidden')) {
        closeCameraModal();
      }
    }
  });

  /* ── Drag & drop ── */
  els.uploadArea.addEventListener('dragenter', e => { e.preventDefault(); els.uploadArea.classList.add('drag-over'); });
  els.uploadArea.addEventListener('dragover',  e => { e.preventDefault(); els.uploadArea.classList.add('drag-over'); });
  els.uploadArea.addEventListener('dragleave', () => els.uploadArea.classList.remove('drag-over'));
  els.uploadArea.addEventListener('drop', e => {
    e.preventDefault();
    els.uploadArea.classList.remove('drag-over');
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  });

  // Also allow dropping anywhere
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      if (state.panel === 'hero' || state.panel === 'batch-preview') {
        handleFiles(e.dataTransfer.files);
      }
    }
  });

  /* ── Clipboard paste ── */
  document.addEventListener('paste', e => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const pastedFiles = [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) pastedFiles.push(file);
      }
    }
    if (pastedFiles.length > 0) {
      if (state.panel === 'hero' || state.panel === 'batch-preview') {
        handleFiles(pastedFiles);
      } else if (state.panel === 'crop-select' || state.panel === 'auto-crop' || state.panel === 'manual-crop') {
        // Allow repasting to change image
        handleFiles(pastedFiles);
      }
    }
  });

  /* ── Batch Preview Actions ── */
  if (els.batchCancelBtn) {
    els.batchCancelBtn.addEventListener('click', resetToHero);
  }
  if (els.batchAddBtn) {
    els.batchAddBtn.addEventListener('click', () => {
      els.fileInput.click();
    });
  }
  if (els.batchExtractBtn) {
    els.batchExtractBtn.addEventListener('click', runBatchExtraction);
  }
  if (els.batchCopyAllBtn) {
    els.batchCopyAllBtn.addEventListener('click', copyAllBatchCode);
  }

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
    if (state.manualCropper) { state.manualCropper.destroy(); state.manualCropper = null; }
    showPanel('crop-select');
  });
  if (els.manualResetBtn) {
    els.manualResetBtn.addEventListener('click', () => {
      state.manualCropper?.resetSel();
    });
  }
  els.manualExtractBtn.addEventListener('click', () => {
    if (!state.manualCropper) return;
    const dataURL = state.manualCropper.getCroppedDataURL();
    if (!dataURL) { showToast('Please draw a selection first.', 'error'); return; }
    runExtraction(dataURL);
  });

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
    if (state.isBatch) {
      showPanel('batch-preview');
    } else {
      showPanel('crop-select');
    }
  });

  els.extractAnotherBtn.addEventListener('click', resetToHero);

  /* ── Auth modal ── */
  els.tabSignin.addEventListener('click', () => switchAuthTab('signin'));
  els.tabSignup.addEventListener('click', () => switchAuthTab('signup'));

  els.signinEye.addEventListener('click', () =>
    toggleEye(els.signinPassword, els.signinEyeShow, els.signinEyeHide));
  els.signupEye.addEventListener('click', () =>
    toggleEye(els.signupPassword, els.signupEyeShow, els.signupEyeHide));
  if (els.signupConfirmEye && els.signupPasswordConfirm) {
    els.signupConfirmEye.addEventListener('click', () =>
      toggleEye(els.signupPasswordConfirm, els.signupConfirmEyeShow, els.signupConfirmEyeHide));
  }

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
    if (state.isBatch && state.batchItems && state.batchItems.length > 0) {
      runBatchExtraction();
    } else if (state.croppedDataURL) {
      runExtraction(state.croppedDataURL);
    } else if (state.uploadedDataURL) {
      runExtraction(state.uploadedDataURL);
    } else {
      if (els.fileInput) els.fileInput.click();
    }
  });
  if (els.errorReportBtn) {
    els.errorReportBtn.addEventListener('click', () => {
      closeModal(els.errorModal);
      openFeedbackModal();
    });
  }

  /* ── Server status banner retry ── */
  if (els.serverStatusRetryBtn) {
    els.serverStatusRetryBtn.addEventListener('click', () => {
      checkServerConnection();
    });
  }

  /* ── Feedback modal ── */
  if (els.reportIssueResultBtn) {
    els.reportIssueResultBtn.addEventListener('click', openFeedbackModal);
  }
  if (els.footerReportLink) {
    els.footerReportLink.addEventListener('click', e => {
      e.preventDefault();
      openFeedbackModal();
    });
  }
  if (els.feedbackModalClose) {
    els.feedbackModalClose.addEventListener('click', closeFeedbackModal);
  }
  if (els.feedbackCancelBtn) {
    els.feedbackCancelBtn.addEventListener('click', closeFeedbackModal);
  }
  if (els.feedbackForm) {
    els.feedbackForm.addEventListener('submit', handleFeedbackSubmit);
  }
  if (els.feedbackDesc && els.feedbackCharCount) {
    els.feedbackDesc.addEventListener('input', () => {
      els.feedbackCharCount.textContent = `${els.feedbackDesc.value.length} / 500`;
    });
  }

  /* ── History drawer ── */
  if (els.navHistoryBtn) {
    els.navHistoryBtn.addEventListener('click', openHistoryDrawer);
  }
  if (els.mobileNavHistory) {
    els.mobileNavHistory.addEventListener('click', () => {
      if (mobileNav) mobileNav.classList.add('hidden');
      openHistoryDrawer();
    });
  }
  if (els.historyCloseBtn) {
    els.historyCloseBtn.addEventListener('click', closeHistoryDrawer);
  }
  if (els.historyBackdrop) {
    els.historyBackdrop.addEventListener('click', closeHistoryDrawer);
  }

  /* ── Rate Us Modal ── */
  if (els.rateModalClose) {
    els.rateModalClose.addEventListener('click', dismissRatingFor7Days);
  }
  if (els.rateMaybeLaterBtn) {
    els.rateMaybeLaterBtn.addEventListener('click', dismissRatingFor7Days);
  }
  if (els.rateSubmitBtn) {
    els.rateSubmitBtn.addEventListener('click', submitRating);
  }
  const starBtns = document.querySelectorAll('#star-rating-wrap .star-btn');
  starBtns.forEach((btn, idx) => {
    const starVal = idx + 1;
    btn.addEventListener('mouseenter', () => {
      starBtns.forEach((b, i) => {
        b.style.color = (i < starVal) ? '#eab308' : '#475569';
      });
    });
    btn.addEventListener('mouseleave', () => {
      updateStarsUI(state.selectedRating || 5);
    });
    btn.addEventListener('click', () => {
      updateStarsUI(starVal);
    });
  });
  if (els.rateFeedbackText && els.rateCharCount) {
    els.rateFeedbackText.addEventListener('input', () => {
      els.rateCharCount.textContent = `${els.rateFeedbackText.value.length}/200`;
    });
  }

  /* ── Close modals on backdrop click ── */
  [els.authModal, els.errorModal, els.feedbackModal, els.rateModal].forEach(modal => {
    if (modal) modal.addEventListener('click', e => {
      if (e.target === modal) closeModal(modal);
    });
  });

  /* ── Close modals and drawer on Escape ── */
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      [els.authModal, els.errorModal, els.feedbackModal, els.rateModal].forEach(modal => {
        if (modal && !modal.classList.contains('hidden')) closeModal(modal);
      });
      if (els.historyDrawerWrap && !els.historyDrawerWrap.classList.contains('hidden')) {
        closeHistoryDrawer();
      }
    }
  });
}

/* ═══════════════════════════════════════════════
   FEEDBACK / BUG REPORT
═══════════════════════════════════════════════ */
function openFeedbackModal() {
  if (!els.feedbackModal) return;
  els.feedbackForm?.reset();
  if (els.feedbackCharCount) els.feedbackCharCount.textContent = '0 / 500';
  openModal(els.feedbackModal);
}

function closeFeedbackModal() {
  if (!els.feedbackModal) return;
  closeModal(els.feedbackModal);
  if (window.location.hash) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
}

async function handleFeedbackSubmit(e) {
  if (e) e.preventDefault();
  const type = els.feedbackType ? els.feedbackType.value : 'Other';
  const desc = els.feedbackDesc ? els.feedbackDesc.value.trim() : '';

  if (els.feedbackSubmitBtn) {
    els.feedbackSubmitBtn.disabled = true;
    els.feedbackSubmitBtn.innerHTML = `
      <div class="spinner" style="width:14px;height:14px;border-width:2px;margin:0 auto"></div>
      Sending…`;
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (state.authToken) {
      headers['Authorization'] = `Bearer ${state.authToken}`;
    }

    const res = await fetch('/api/feedback', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type,
        description: desc,
        page: window.location.pathname || 'index.html'
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to submit report.');

    closeFeedbackModal();
    showToast('Report submitted. Thank you for your feedback!', 'success');
  } catch (err) {
    showToast(err.message || 'Could not send feedback. Please try again.', 'error');
  } finally {
    if (els.feedbackSubmitBtn) {
      els.feedbackSubmitBtn.disabled = false;
      els.feedbackSubmitBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        Submit Report`;
    }
  }
}

/* ═══════════════════════════════════════════════
   CROP ENTRY POINTS
═══════════════════════════════════════════════ */
function enterAutoCrop() {
  if (!state.uploadedImg) return;
  // Silent Auto Crop — detect code region, crop offscreen, and extract immediately with 0 clicks
  const croppedDataURL = autoCropImage(state.uploadedImg);
  const dataURL = croppedDataURL || state.uploadedDataURL;
  runExtraction(dataURL);
}

function enterManualCrop() {
  if (!state.uploadedImg) return;
  showPanel('manual-crop');

  // Reset button and hint state
  els.manualExtractBtn.disabled = true;
  els.manualExtractBtn.setAttribute('aria-disabled', 'true');
  if (els.manualResetBtn) els.manualResetBtn.classList.add('hidden');
  if (els.manualHintLbl) {
    els.manualHintLbl.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><path d="M9 3v18"/><path d="M15 3v18"/><path d="M3 9h18"/><path d="M3 15h18"/></svg>
      Drag a selection box over the code area
    `;
  }

  requestAnimationFrame(() => {
    if (state.manualCropper) state.manualCropper.destroy();
    state.manualCropper = new ManualCropper(
      els.manualCropCanvas,
      state.uploadedImg,
      (sel) => {
        const hasValid = sel && sel.w > 8 && sel.h > 8;
        els.manualExtractBtn.disabled = !hasValid;
        els.manualExtractBtn.setAttribute('aria-disabled', String(!hasValid));
        if (hasValid) {
          if (els.manualResetBtn) els.manualResetBtn.classList.remove('hidden');
          if (els.manualHintLbl) {
            els.manualHintLbl.innerHTML = `
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--success)"><polyline points="20 6 9 17 4 12"/></svg>
              <strong>${sel.w} × ${sel.h} px</strong> selected — click Confirm Crop to extract
            `;
          }
        } else {
          if (els.manualResetBtn) els.manualResetBtn.classList.add('hidden');
          if (els.manualHintLbl) {
            els.manualHintLbl.innerHTML = `
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><path d="M9 3v18"/><path d="M15 3v18"/><path d="M3 9h18"/><path d="M3 15h18"/></svg>
              Drag a selection box over the code area
            `;
          }
        }
      }
    );
  });
}

/* ═══════════════════════════════════════════════
   INIT
/* ═══════════════════════════════════════════════
   CONNECTION & COLD-START CHECK
═══════════════════════════════════════════════ */
let checkConnectionTimer = null;
async function checkServerConnection(isRetry = false) {
  const banner = document.getElementById('server-status-banner');
  const msgEl = document.getElementById('server-status-msg');
  if (!banner || !msgEl) return;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch('/health', { signal: controller.signal });
    clearTimeout(timer);

    if (res.ok) {
      banner.classList.add('hidden');
      banner.classList.remove('warming');
      if (checkConnectionTimer) {
        clearTimeout(checkConnectionTimer);
        checkConnectionTimer = null;
      }
      return true;
    } else {
      banner.classList.remove('hidden');
      banner.classList.remove('warming');
      msgEl.textContent = 'Service temporarily unavailable — please try again in a moment';
      return false;
    }
  } catch (err) {
    banner.classList.remove('hidden');
    if (err.name === 'AbortError' || isRetry) {
      banner.classList.add('warming');
      msgEl.textContent = 'Warming up... please wait a moment';
      if (checkConnectionTimer) clearTimeout(checkConnectionTimer);
      checkConnectionTimer = setTimeout(() => checkServerConnection(true), 3000);
    } else {
      banner.classList.remove('warming');
      msgEl.textContent = 'Service temporarily unavailable — please try again in a moment';
      if (checkConnectionTimer) clearTimeout(checkConnectionTimer);
      checkConnectionTimer = setTimeout(() => checkServerConnection(true), 5000);
    }
    return false;
  }
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
  checkServerConnection();
  // Clear any report hash from URL on refresh so modal never auto-opens
  if (window.location.hash === '#report-issue' || window.location.hash === '#report') {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  // Verify token with server in the background
  if (state.authToken) {
    refreshAuthState().then(updateUserPill);
  }
  console.log('%c CodeSnapper loaded ❖', 'color:#a78bfa;font-weight:bold;font-size:16px');
}

/* ═══════════════════════════════════════════════
   GLOBAL UNHANDLED ERROR CATCH-ALL
═══════════════════════════════════════════════ */
window.addEventListener('error', (event) => {
  console.error('[CodeSnapper] Unhandled error:', event.error || event.message);
  if (state.panel === 'processing') {
    showPanel(state.isBatch ? 'batch-preview' : 'crop-select');
  }
  showError('Something went wrong. Please try again.');
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('[CodeSnapper] Unhandled rejection:', event.reason);
  if (state.panel === 'processing') {
    showPanel(state.isBatch ? 'batch-preview' : 'crop-select');
  }
  showError('Something went wrong. Please try again.');
});

document.addEventListener('DOMContentLoaded', init);
