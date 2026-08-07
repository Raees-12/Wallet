const API_URL = '/api/wallet';
const D_LOGO_SRC = 'Assets/d_logo.png';
const L_LOGO_SRC = 'Assets/l_logo.png';

const DEFAULT_EXPENSE = ['Food','Travel','Rent','Mobile & Internet','Fun','Daily Needs','Health & Personal Care','Miscellaneous','EMIs & Loans','Savings (Personal)','Savings (Parents)','Emergency Fund','Lifestyle','Gift','Business Invest'];
const DEFAULT_INCOME  = ['Salary','Business','Freelance','Investment','Gift'];
const DEFAULT_LOAN    = ['Lent','Borrowed'];
const DEFAULT_EMI     = ['Credit Card Loan','Personal Loan'];

let currentUser = null;
let appData = { expenses:[], income:[], loans:[], loanSummary:[], emis:[], emiPayments:[], config:{expense:[],income:[],loan:[]} };
let currentPage = 'dashboard';
let balanceHidden = true; // default hidden
let currentAddTab = 'expense';
let currentLoanAction = null;
let currentReportType = 'daily';
let dashFilterType = 'month';
let showSettledLoans = false;
let currentPersonKey = null;
let dashFilterRange = { from: null, to: null };
// Default filter = current month (YYYY-MM format)
const _now = new Date();
const _curMonth = `${_now.getFullYear()}-${String(_now.getMonth()+1).padStart(2,'0')}`;

let reportData = null;

// ── CONFIG STATE (checked/unchecked + custom) ──
let configState = {
  expense: { checked: new Set(DEFAULT_EXPENSE), custom: [] },
  income:  { checked: new Set(DEFAULT_INCOME),  custom: [] },
  loan:    { checked: new Set(DEFAULT_LOAN),     custom: [] },
  emi:     { checked: new Set(DEFAULT_EMI),      custom: [] }
};

// ── DATE UTILS ──
function parseSheetDate(val) {
  if (!val) return 0;
  const s = String(val).trim();
  // DD/MM/YYYY (already formatted correctly — most common case)
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
    const [d,m,y] = s.split('/');
    return new Date(+y, +m-1, +d).getTime();
  }
  // ISO datetime e.g. 2026-05-01T18:30:00.000Z
  // Google Sheets sends UTC midnight which shifts to previous day in IST (+5:30)
  // Fix: parse local date components, not UTC
  if (s.includes('T')) {
    const dt = new Date(s);
    // Use local date to respect user's timezone (IST etc.)
    return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime();
  }
  // ISO date only e.g. 2026-05-01
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y,m,d] = s.split('-');
    return new Date(+y, +m-1, +d).getTime();
  }
  // Google Sheets serial date number (integer)
  if (!isNaN(s) && s !== '') {
    const serial = Number(s);
    // Sheets epoch is Dec 30, 1899
    const msPerDay = 86400000;
    const epoch = new Date(1899, 11, 30).getTime();
    const ts = epoch + serial * msPerDay;
    const d = new Date(ts);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }
  return new Date(s).getTime() || 0;
}

// Sort key: use stored timestamp if available, else row index (preserved from API order)
// rowIdx is the original position in the data array (higher = newer = appended later)
function sortKey(row, rowIdx) {
  const ts = row['Timestamp'] || row['timestamp'];
  if (ts && !isNaN(Number(ts))) return Number(ts);
  // Fallback: date + row index as tiebreaker (row index * small factor)
  return parseSheetDate(row['Date'] || row['date'] || '') + (rowIdx || 0);
}

function fmtDisplay(val) {
  if (!val || val === '-') return '-';
  const s = String(val).trim();
  if (s === '-' || s === '') return '-';
  const ts = parseSheetDate(s);
  if (!ts) {
    // Last resort: strip ISO and show raw date part
    const isoDate = s.split('T')[0];
    if (/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
      const [y,m,d] = isoDate.split('-');
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return `${d} ${months[+m-1]} ${y}`;
    }
    return s;
  }
  const d = new Date(ts);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${String(d.getDate()).padStart(2,'0')} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

function fmtDateForSheet(iso) {
  if (!iso) return '';
  const [y,m,d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function todayISO() { return new Date().toISOString().split('T')[0]; }

function fmt(n) {
  const num = Number(n) || 0;
  return '₹' + num.toLocaleString('en-IN', prefs.decimals
    ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
    : { maximumFractionDigits: 0 });
}

// Escape text before it goes into innerHTML / inline onclick attributes
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Format with small superscript decimal part
function fmtSplit(n) {
  const num = Number(n);
  const abs = Math.abs(num);
  const sign = num < 0 ? '-' : '';
  const str = abs.toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2});
  const dot = str.lastIndexOf('.');
  const main = str.slice(0, dot);
  const dec  = str.slice(dot+1);
  return `${sign}<span class="bal-symbol">₹</span><span class="bal-main">${main}</span><span class="bal-dec">.${dec}</span>`;
}

function fmtBalance(n) {
  if (balanceHidden) {
    return '<span class="bal-symbol">₹</span><span class="bal-main">XXXX</span><span class="bal-dec">.XX</span>';
  }
  return fmtSplit(n);
}

function fmtMini(n) {
  // For mini tiles inside balance card - show XXXX or normal
  if (balanceHidden) return '₹XXXX';
  return fmt(n);
}

function getDateRange(type) {
  const now = new Date();
  let from, to;
  if (type === 'today') {
    from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    to   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  } else if (type === 'week') {
    const day = now.getDay();
    from = new Date(now); from.setDate(now.getDate() - day);
    from = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    to   = new Date(from); to.setDate(from.getDate() + 6); to.setHours(23,59,59);
  } else if (type === 'month') {
    from = new Date(now.getFullYear(), now.getMonth(), 1);
    to   = new Date(now.getFullYear(), now.getMonth()+1, 0, 23, 59, 59);
  } else if (type === 'range' && dashFilterRange.from && dashFilterRange.to) {
    const [fy,fm,fd] = dashFilterRange.from.split('-');
    const [ty,tm,td] = dashFilterRange.to.split('-');
    from = new Date(+fy, +fm-1, +fd);
    to   = new Date(+ty, +tm-1, +td, 23, 59, 59);
  } else {
    // month chip e.g. "2026-05"
    const [y,m] = type.split('-');
    if (y && m) {
      from = new Date(+y, +m-1, 1);
      to   = new Date(+y, +m, 0, 23, 59, 59);
    } else {
      from = new Date(now.getFullYear(), now.getMonth(), 1);
      to   = new Date(now.getFullYear(), now.getMonth()+1, 0, 23, 59, 59);
    }
  }
  return { from: from.getTime(), to: to.getTime() };
}

// ── PERSISTENCE ──
const SESSION_KEY = 'wallet_session_v2';
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

function saveSession(u) {
  const payload = JSON.stringify({ user: u, savedAt: Date.now() });
  try { localStorage.setItem(SESSION_KEY, payload); } catch(e) {}
  try { sessionStorage.setItem(SESSION_KEY, payload); } catch(e) {}
  // Also save as cookie fallback (30 days)
  try {
    const exp = new Date(Date.now() + SESSION_TTL).toUTCString();
    document.cookie = `${SESSION_KEY}=${encodeURIComponent(payload)};expires=${exp};path=/;SameSite=Lax`;
  } catch(e) {}
}
function loadSession() {
  try {
    // Try localStorage first
    let raw = localStorage.getItem(SESSION_KEY);
    // Fallback to sessionStorage
    if (!raw) raw = sessionStorage.getItem(SESSION_KEY);
    // Fallback to cookie
    if (!raw) {
      const match = document.cookie.match(new RegExp('(?:^|; )' + SESSION_KEY + '=([^;]*)'));
      if (match) raw = decodeURIComponent(match[1]);
    }
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Support both old format (plain user object) and new format {user, savedAt}
    const user = parsed.user || parsed;
    const savedAt = parsed.savedAt || 0;
    // Expire after 30 days
    if (savedAt && Date.now() - savedAt > SESSION_TTL) { clearSession(); return null; }
    return user;
  } catch(e) { return null; }
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); localStorage.removeItem('wallet_user'); } catch(e) {}
  try { sessionStorage.removeItem(SESSION_KEY); sessionStorage.removeItem('wallet_user'); } catch(e) {}
  try { document.cookie = `${SESSION_KEY}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`; } catch(e) {}
}
// ══════════════════════════════════════════════════════════════
// MULTI-ACCOUNT
// Every API call is keyed by userId only, so switching accounts is just a
// matter of swapping currentUser — no re-authentication needed. Accounts are
// remembered on this device until explicitly removed.
// ══════════════════════════════════════════════════════════════
const ACCOUNTS_KEY = 'wallet_accounts_v1';
let accounts = [];         // [{id, username, email}]
let addingAccount = false; // true while the login screen is open from the switcher

function loadAccounts() {
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY);
    if (raw) { const a = JSON.parse(raw); if (Array.isArray(a)) return a.filter(x => x && x.id); }
  } catch(e) {}
  return [];
}
function persistAccounts() {
  try { localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts)); } catch(e) {}
}
function upsertAccount(u) {
  if (!u || !u.id) return;
  const entry = { id: u.id, username: u.username, email: u.email || '' };
  const idx = accounts.findIndex(a => String(a.id) === String(u.id));
  if (idx >= 0) accounts[idx] = entry; else accounts.push(entry);
  persistAccounts();
}
function dropAccount(id) {
  accounts = accounts.filter(a => String(a.id) !== String(id));
  persistAccounts();
}
function clearCacheFor(id) {
  try { localStorage.removeItem('wallet_cache_' + id); } catch(e) {}
}

function saveTheme(t) { try{localStorage.setItem('wallet_theme',t);}catch(e){} }
function loadTheme() { try{return localStorage.getItem('wallet_theme')||'light';}catch(e){return 'light';} }

// ── ACCENT COLOR (personalized theming) ──
function saveAccent(hex) { try{localStorage.setItem('wallet_accent',hex);}catch(e){} }
function loadAccent() { try{return localStorage.getItem('wallet_accent')||'#1a73e8';}catch(e){return '#1a73e8';} }

function hexToRgbObj(hex) {
  hex = String(hex).replace('#','').trim();
  if (hex.length === 3) hex = hex.split('').map(c=>c+c).join('');
  const num = parseInt(hex,16);
  return { r:(num>>16)&255, g:(num>>8)&255, b:num&255 };
}
function rgbToHex(r,g,b) {
  const c = v => Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,'0');
  return '#' + c(r) + c(g) + c(b);
}
// Shift a hex color's HSL lightness by deltaPct (-100..100), preserving hue/saturation
function shiftLightness(hex, deltaPct) {
  const {r,g,b} = hexToRgbObj(hex);
  const rn=r/255, gn=g/255, bn=b/255;
  const max=Math.max(rn,gn,bn), min=Math.min(rn,gn,bn);
  let h=0, s=0; const l0=(max+min)/2;
  const d=max-min;
  if (d !== 0) {
    s = l0 > 0.5 ? d/(2-max-min) : d/(max+min);
    switch(max){
      case rn: h=((gn-bn)/d + (gn<bn?6:0)); break;
      case gn: h=((bn-rn)/d + 2); break;
      default: h=((rn-gn)/d + 4);
    }
    h/=6;
  }
  const l = Math.max(0, Math.min(1, l0 + deltaPct/100));
  function hue2rgb(p,q,t){
    if(t<0)t+=1; if(t>1)t-=1;
    if(t<1/6) return p+(q-p)*6*t;
    if(t<1/2) return q;
    if(t<2/3) return p+(q-p)*(2/3-t)*6;
    return p;
  }
  let nr,ng,nb;
  if (s===0){ nr=ng=nb=l; }
  else {
    const q = l<0.5 ? l*(1+s) : l+s-l*s;
    const p = 2*l-q;
    nr=hue2rgb(p,q,h+1/3); ng=hue2rgb(p,q,h); nb=hue2rgb(p,q,h-1/3);
  }
  return rgbToHex(nr*255, ng*255, nb*255);
}

function setAccent(hex) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) hex = '#1a73e8';
  hex = hex.toLowerCase();
  const light = shiftLightness(hex, 14);
  const dark1 = shiftLightness(hex, -16);
  const dark2 = shiftLightness(hex, -30);
  const glassTint = shiftLightness(hex, -34);
  const {r,g,b} = hexToRgbObj(hex);
  const root = document.documentElement.style;
  root.setProperty('--blue', hex);
  root.setProperty('--blue-light', light);
  root.setProperty('--blue-dark1', dark1);
  root.setProperty('--blue-dark2', dark2);
  root.setProperty('--blue-rgb', `${r},${g},${b}`);
  root.setProperty('--glass-bg-dynamic',
    `linear-gradient(165deg,#0b0a12 0%,${glassTint} 45%,#1a1226 78%,#120e1c 100%)`);
  saveAccent(hex);

  let matchedPreset = false;
  document.querySelectorAll('.accent-dot[data-accent]').forEach(d => {
    const isMatch = d.dataset.accent.toLowerCase() === hex;
    d.classList.toggle('active', isMatch);
    if (isMatch) matchedPreset = true;
  });
  const customDot = document.getElementById('accent-custom-dot');
  if (customDot) customDot.classList.toggle('active', !matchedPreset);
  const picker = document.getElementById('accent-picker');
  if (picker) picker.value = hex;

  updateMetaThemeColor();
}

function refreshThemeRow() {
  const el = document.getElementById('settings-theme-value');
  if (el) el.textContent = THEME_LABELS[document.documentElement.getAttribute('data-theme')] || 'Light';
}

function updateMetaThemeColor() {
  const theme = document.documentElement.getAttribute('data-theme') || 'light';
  const meta = document.getElementById('meta-theme-color');
  if (!meta) return;
  const fixed = { dark:'#13131a', amoled:'#000000', glass:'#0d0b14' };
  meta.content = fixed[theme] || document.documentElement.style.getPropertyValue('--blue').trim() || '#1a73e8';
}

// ── AVATAR GESTURES ──
// Tap        → Profile
// Double-tap → jump straight to the next account (no picker)
// Hold       → open the account picker
let _tapTimer       = null;
let _longPressTimer = null;
let _longPressFired = false;
let _pointerMoved   = false;
let _pointerStart   = null;
const LONG_PRESS_MS = 500;
const DOUBLE_TAP_MS = 280;

function initAvatarGestures() {
  const av = document.getElementById('topbar-avatar');
  if (!av) return;

  // Stop the OS text-selection / callout menu that a double-tap normally triggers
  av.addEventListener('contextmenu', e => e.preventDefault());
  av.addEventListener('selectstart', e => e.preventDefault());
  av.addEventListener('dblclick',    e => e.preventDefault());

  av.addEventListener('pointerdown', e => {
    _longPressFired = false;
    _pointerMoved   = false;
    _pointerStart   = { x: e.clientX, y: e.clientY };
    clearTimeout(_longPressTimer);
    _longPressTimer = setTimeout(() => {
      _longPressFired = true;
      clearTimeout(_tapTimer); _tapTimer = null;
      buzz(15);
      openAccountSwitcher();
    }, LONG_PRESS_MS);
  });

  // A drag/scroll shouldn't count as a press
  av.addEventListener('pointermove', e => {
    if (!_pointerStart) return;
    if (Math.abs(e.clientX - _pointerStart.x) > 10 || Math.abs(e.clientY - _pointerStart.y) > 10) {
      _pointerMoved = true;
      clearTimeout(_longPressTimer);
    }
  });

  ['pointerup','pointercancel','pointerleave'].forEach(ev =>
    av.addEventListener(ev, () => clearTimeout(_longPressTimer)));

  av.addEventListener('click', e => {
    e.preventDefault();
    if (_longPressFired || _pointerMoved) { _longPressFired = false; return; }
    handleAvatarTap();
  });
}

function handleAvatarTap() {
  if (_tapTimer) {
    // Second tap inside the window — this is a double-tap
    clearTimeout(_tapTimer);
    _tapTimer = null;
    switchToNextAccount();
    return;
  }
  _tapTimer = setTimeout(() => {
    _tapTimer = null;
    openProfile();
  }, DOUBLE_TAP_MS);
}

// Cycles through the saved accounts in order, wrapping around at the end.
async function switchToNextAccount() {
  if (accounts.length < 2) {
    showToast('Add another account to switch between them');
    openAccountSwitcher();
    return;
  }
  const i = accounts.findIndex(a => currentUser && String(a.id) === String(currentUser.id));
  const next = accounts[(i + 1) % accounts.length];
  await switchAccount(next.id);
}

function openAccountSwitcher() {
  if (currentUser && !accounts.length) upsertAccount(currentUser);
  renderAccountSwitcher();
  document.getElementById('account-overlay').classList.add('open');
}

function renderAccountSwitcher() {
  renderAccountRows('account-list');
}

// Renders the account list into any container — used by both the long-press
// sheet and the Accounts section of the Settings page.
function renderAccountRows(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!accounts.length) {
    el.innerHTML = '<div style="text-align:center;color:var(--text3);padding:24px;font-size:13px">No accounts saved yet</div>';
    return;
  }
  el.innerHTML = accounts.map(a => {
    const isActive = currentUser && String(a.id) === String(currentUser.id);
    const name = esc(a.username || 'User');
    const mail = esc(a.email || '');
    const idAttr = esc(String(a.id));
    return `<div class="account-row ${isActive ? 'active' : ''}" onclick="switchAccount('${idAttr}')">
      <div class="account-avatar">${name.charAt(0).toUpperCase()}</div>
      <div class="account-info">
        <div class="account-name">${name}${isActive ? '<span class="account-current">Current</span>' : ''}</div>
        <div class="account-email">${mail || '&nbsp;'}</div>
      </div>
      ${isActive
        ? `<svg class="account-check" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>`
        : `<button class="account-remove" title="Remove account"
             onclick="event.stopPropagation();removeAccountConfirm('${idAttr}','${name}')">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
           </button>`}
    </div>`;
  }).join('');
}

// Reset every piece of per-user view state so one account never shows
// another's numbers, filters, or open sheets.
function resetAppState() {
  appData = { expenses:[], income:[], loans:[], loanSummary:[], emis:[], emiPayments:[], accounts:[], config:{} };
  balanceHidden   = prefs.hideBalance;
  summaryType     = 'expense';
  summaryPeriod   = 'monthly';
  summaryAnchor   = { y: new Date().getFullYear(), m: new Date().getMonth() };
  summaryCats     = null;
  summaryCustom   = { from: null, to: null };
  summarySel      = null;
  anaPeriod       = 'monthly';
  anaView.flow    = { offset: 0, selected: BUCKET_COUNT - 1 };
  anaView.net     = { offset: 0, selected: BUCKET_COUNT - 1 };
  netUnit         = 'cur';
  anaCalDay       = null;
  calRef          = null;
  anaAccount      = null;
  dashFilterType  = 'month';
  dashFilterRange = { from: null, to: null };
  showSettledLoans   = false;
  currentPersonKey   = null;
  currentEMI         = null;
  currentLoanAction  = null;
  currentEntryDetail = null;
  reportData         = null;
  Object.keys(_entryRegistry).forEach(k => delete _entryRegistry[k]);
  // Close anything left open from the previous account
  ['person-loans-overlay','loan-action-overlay','emi-action-overlay',
   'entry-detail-overlay','add-overlay','emi-add-overlay','cat-entries-overlay',
   'datepick-overlay','type-overlay','period-overlay','catfilter-overlay',
   'anaperiod-overlay','day-overlay'].forEach(id => {
    const o = document.getElementById(id); if (o) o.classList.remove('open');
  });
  // Reset dashboard chips back to "This Month"
  document.querySelectorAll('.dash-chip').forEach(c =>
    c.classList.toggle('active', c.dataset.type === 'month'));
  const rangeRow = document.getElementById('dash-range-row');
  if (rangeRow) rangeRow.style.display = 'none';
  const out = document.getElementById('report-output');
  if (out) out.innerHTML = '<div class="report-placeholder">Select a period and generate your report</div>';
  const expBtns = document.getElementById('report-export-btns');
  if (expBtns) expBtns.style.display = 'none';
  updateEyeIcon();
  renderAll();
}

async function switchAccount(id) {
  const a = accounts.find(x => String(x.id) === String(id));
  if (!a) return;
  closeOverlay('account-overlay');
  closeSettings();
  if (currentUser && String(currentUser.id) === String(id)) return;
  currentUser = { id: a.id, username: a.username, email: a.email };
  saveSession(currentUser);
  resetAppState();
  initMainScreen();
  switchPage('dashboard');
  showScreen('main-screen');
  showToast('Switched to ' + a.username);
  await loadAllData();
}

function startAddAccount() {
  addingAccount = true;
  closeOverlay('account-overlay');
  closeSettings();
  document.getElementById('login-user').value = '';
  document.getElementById('login-pass').value = '';
  document.getElementById('login-err').textContent = '';
  const cancel = document.getElementById('login-cancel');
  if (cancel) cancel.style.display = currentUser ? 'flex' : 'none';
  showScreen('login-screen');
}

function cancelAddAccount() {
  addingAccount = false;
  const cancel = document.getElementById('login-cancel');
  if (cancel) cancel.style.display = 'none';
  if (currentUser) showScreen('main-screen');
}

function removeAccountConfirm(id, name) {
  showConfirm(
    `Remove ${name} from this device?\n\nThe account's data stays safe — you'll just need the password to add it back.`,
    () => {
      clearCacheFor(id);
      dropAccount(id);
      if (currentUser && String(currentUser.id) === String(id)) {
        if (accounts.length) { switchAccount(accounts[0].id); return; }
        clearSession(); currentUser = null;
        closeOverlay('account-overlay');
        closeSettings();
        showScreen('login-screen');
        return;
      }
      updateAccountBadge();
      renderAccountSwitcher();
    },
    'Remove'
  );
}

function logoutAllConfirm() {
  showConfirm(
    'Log out of all accounts on this device?',
    () => {
      accounts.forEach(a => clearCacheFor(a.id));
      accounts = [];
      persistAccounts();
      clearSession();
      currentUser = null;
      appData = { expenses:[], income:[], loans:[], loanSummary:[], emis:[], emiPayments:[], config:{} };
      closeOverlay('account-overlay');
      closeSettings();
      document.getElementById('login-user').value = '';
      document.getElementById('login-pass').value = '';
      document.getElementById('login-err').textContent = '';
      const cancel = document.getElementById('login-cancel');
      if (cancel) cancel.style.display = 'none';
      showScreen('login-screen');
    },
    'Log out'
  );
}

// Small dot on the avatar hinting that more than one account is available
function updateAccountBadge() {
  const av = document.getElementById('topbar-avatar');
  if (av) av.classList.toggle('multi', accounts.length > 1);
  if (_settingsOpen) { renderSettings(); renderAccountRows('settings-accounts-list'); }
}

// ── INIT ──
document.addEventListener('DOMContentLoaded', () => {
  loadPrefs();
  balanceHidden = prefs.hideBalance;
  const theme = loadTheme();
  applyTheme(theme);
  setAccent(loadAccent());
  updateEyeIcon();
  initAvatarGestures();
  initAnaSwipes();
  accounts = loadAccounts();
  const saved = loadSession();
  // Restore the last active account; fall back to the first saved account if
  // the session blob expired but the account list is still there.
  const active = saved || (accounts.length ? accounts[0] : null);
  if (active) {
    currentUser = active;
    upsertAccount(currentUser); // migrates users who logged in before multi-account existed
    saveSession(currentUser);
    initMainScreen();
    showScreen('main-screen');
    loadAllData();
    handleLaunchAction();
  }
  updateAccountBadge();
});

// ── AUTH ──
async function doLogin() {
  const username = document.getElementById('login-user').value.trim();
  const password = document.getElementById('login-pass').value.trim();
  const err = document.getElementById('login-err');
  err.textContent = '';
  if (!username||!password){err.textContent='Please fill in all fields';return;}
  const btn = document.getElementById('login-btn');
  btn.textContent = 'Signing in...'; btn.disabled = true;
  try {
    const res = await api({action:'login',username,password});
    if (res.success) {
      const already = accounts.some(a => String(a.id) === String(res.user.id));
      currentUser = res.user;
      upsertAccount(currentUser);
      saveSession(currentUser);
      addingAccount = false;
      const cancel = document.getElementById('login-cancel');
      if (cancel) cancel.style.display = 'none';
      document.getElementById('login-pass').value = '';
      resetAppState();
      initMainScreen();
      switchPage('dashboard');
      showScreen('main-screen');
      if (already) showToast('Switched to ' + currentUser.username);
      loadAllData();
    } else { err.textContent = res.error||'Invalid credentials'; }
  } catch(e) { err.textContent = 'Connection error'; }
  btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>Sign In';
  btn.disabled = false;
}

function initMainScreen() {
  const u = currentUser;
  document.getElementById('topbar-greeting').textContent = 'Hi, '+u.username;
  document.getElementById('topbar-avatar').textContent = u.username[0].toUpperCase();
  updateAccountBadge();
}

// Logs out of the CURRENT account only. If other accounts are signed in on
// this device, we hop straight to the next one instead of dumping the user
// back at the login screen.
function doLogout() {
  closeSettings();
  if (currentUser) {
    clearCacheFor(currentUser.id);
    dropAccount(currentUser.id);
  }
  if (accounts.length) {
    switchAccount(accounts[0].id);
    return;
  }
  clearSession();
  currentUser = null;
  appData = {expenses:[],income:[],loans:[],loanSummary:[],emis:[],emiPayments:[],config:{expense:[],income:[],loan:[]}};
  addingAccount = false;
  const cancel = document.getElementById('login-cancel');
  if (cancel) cancel.style.display = 'none';
  document.getElementById('login-user').value = '';
  document.getElementById('login-pass').value = '';
  document.getElementById('login-err').textContent = '';
  showScreen('login-screen');
}

// ── API ──
async function api(params) {
  const url = new URL(API_URL, window.location.origin);
  Object.entries(params).forEach(([k,v]) => url.searchParams.set(k,v));
  const res = await fetch(url.toString());
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch(e) {
    console.error('API non-JSON response:', text);
    throw new Error('API error: ' + text.slice(0, 100));
  }
}

// ── LOAD DATA ──
async function loadAllData(silent = false) {
  // ── INSTANT: show cached data immediately ──
  const cached = loadCachedData();
  if (cached) {
    appData = cached;
    syncConfigStateFromServer();
    buildMonthChips();
    buildDashMonthChips();
    populateCategorySelects();
    populateAccountSelects();
    renderAll();
    // Then refresh in background silently
    refreshFromAPI();
    return;
  }
  // No cache: show spinner and fetch
  if (!silent) {
    document.getElementById('dash-recent').innerHTML = '<div class="loading-wrap"><div class="spinner"></div><div class="loading-text">Loading...</div></div>';
  }
  await refreshFromAPI();
}

async function refreshFromAPI() {
  try {
    // Single API call instead of 6 — much faster
    const res = await api({ action: 'getAllData', userId: currentUser.id });
    if (!res.success) throw new Error(res.error || 'API error');

    appData.expenses    = res.expenses    || [];
    appData.income      = res.income      || [];
    appData.loans       = res.loans       || [];
    appData.loanSummary = res.loanSummary || [];
    appData.config      = res.config      || {};
    appData.emis        = res.emis        || [];
    appData.emiPayments = res.emiPayments || [];

    saveCachedData(appData);
    syncConfigStateFromServer();
    buildMonthChips();
    buildDashMonthChips();
    populateCategorySelects();
    populateAccountSelects();
    renderAll();
  } catch(e) {
    console.error('refreshFromAPI error:', e);
    if (!loadCachedData()) showToast(e.message || 'Failed to load data');
  }
}

function saveCachedData(data) {
  try {
    const slim = {
      expenses: data.expenses,
      income: data.income,
      loans: data.loans,
      loanSummary: data.loanSummary,
      emis: data.emis,
      emiPayments: data.emiPayments,
      config: data.config,
      cachedAt: Date.now()
    };
    localStorage.setItem('wallet_cache_' + currentUser.id, JSON.stringify(slim));
  } catch(e) {}
}

function loadCachedData() {
  try {
    const raw = localStorage.getItem('wallet_cache_' + currentUser.id);
    if (!raw) return null;
    const d = JSON.parse(raw);
    // Cache valid for 5 minutes
    if (Date.now() - (d.cachedAt || 0) > 5 * 60 * 1000) return null;
    return d;
  } catch(e) { return null; }
}

function clearCache() {
  try { localStorage.removeItem('wallet_cache_' + (currentUser?.id || '')); } catch(e) {}
}


async function submitExpense() {
  const p = {action:'addExpense',userId:currentUser.id,date:fmtDateForSheet(document.getElementById('exp-date').value),amount:document.getElementById('exp-amount').value,category:document.getElementById('exp-cat').value,description:document.getElementById('exp-desc').value,paymentMode:document.getElementById('exp-pm').value,remarks:document.getElementById('exp-remarks').value||'-',account:(document.getElementById('add-exp-account')||{}).value||''};
  if(!p.amount||!p.description){showToast('Fill required fields');return;}
  await submitEntry(p,'Expense added');
}
async function submitIncome() {
  const p = {action:'addIncome',userId:currentUser.id,date:fmtDateForSheet(document.getElementById('inc-date').value),amount:document.getElementById('inc-amount').value,category:document.getElementById('inc-cat').value,description:document.getElementById('inc-desc').value,paymentMode:document.getElementById('inc-pm').value,remarks:document.getElementById('inc-remarks').value||'-',account:(document.getElementById('add-inc-account')||{}).value||''};
  if(!p.amount||!p.description){showToast('Fill required fields');return;}
  await submitEntry(p,'Income added');
}
async function submitLoan() {
  const p = {action:'addLoan',userId:currentUser.id,date:fmtDateForSheet(document.getElementById('loan-date').value),amount:document.getElementById('loan-amount').value,category:document.getElementById('loan-type').value,description:document.getElementById('loan-person').value.trim(),paymentMode:document.getElementById('loan-pm').value,remarks:document.getElementById('loan-remarks').value||'-',loanIdInput:''};
  if(!p.amount||!p.description){showToast('Fill required fields');return;}
  await submitEntry(p,'Loan added');
}
async function submitEntry(params,msg) {
  const overlay = document.getElementById('add-overlay');
  const btns = overlay.querySelectorAll('.btn-primary');
  btns.forEach(b=>{b.disabled=true;b.textContent='Saving...';});
  try {
    const res = await api(params);
    if (res.success) { showToast(msg); closeOverlay('add-overlay'); clearAddForm(); await loadAllData(); }
    else { showToast('Error: '+(res.error||'Failed')); }
  } catch(e) { showToast('Connection error'); }
  btns.forEach(b=>{b.disabled=false;});
  document.querySelector('#add-expense .btn-primary').textContent='Add Expense';
  document.querySelector('#add-income .btn-primary').textContent='Add Income';
  document.querySelector('#add-loan .btn-primary').textContent='Add Loan';
  populateCategorySelects();
}
function clearAddForm() {
  ['exp-amount','exp-desc','exp-remarks','inc-amount','inc-desc','inc-remarks','loan-amount','loan-person','loan-remarks'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
}

function syncConfigStateFromServer() {
  const cfg = appData.config || {};
  const toArr = (val) => {
    if (!val) return [];
    if (Array.isArray(val)) return val.filter(Boolean);
    return String(val).split(',').map(s => s.trim()).filter(Boolean);
  };

  const types = ['expense', 'income', 'loan', 'emi'];
  types.forEach(type => {
    const custom    = toArr(cfg[type + 'Custom']);
    const unchecked = toArr(cfg[type + 'Unchecked']);
    // Restore checked set: all defaults minus unchecked
    const defaults = type==='expense'?DEFAULT_EXPENSE:type==='income'?DEFAULT_INCOME:type==='loan'?DEFAULT_LOAN:DEFAULT_EMI;
    configState[type].checked = new Set(defaults.filter(c => !unchecked.includes(c)));
    configState[type].custom  = custom;
  });
}

async function saveConfig() {
  const btn = document.getElementById('cat-save-btn');
  if (btn) { btn.textContent = 'Saving...'; btn.disabled = true; }
  try {
    // Only save custom items + which defaults are unchecked
    // Defaults that ARE checked don't need saving (they're hardcoded)
    const expDefaults = DEFAULT_EXPENSE;
    const incDefaults = DEFAULT_INCOME;
    const loanDefaults = DEFAULT_LOAN;
    const expUnchecked  = expDefaults.filter(c => !configState.expense.checked.has(c));
    const incUnchecked  = incDefaults.filter(c => !configState.income.checked.has(c));
    const loanUnchecked = loanDefaults.filter(c => !configState.loan.checked.has(c));
    const emiUnchecked  = DEFAULT_EMI.filter(c => !configState.emi.checked.has(c));
    const res = await api({
      action: 'saveConfig',
      userId: currentUser.id,
      expenseCustom: configState.expense.custom.join(','),
      expenseUnchecked: expUnchecked.join(','),
      incomeCustom: configState.income.custom.join(','),
      incomeUnchecked: incUnchecked.join(','),
      loanCustom: configState.loan.custom.join(','),
      loanUnchecked: loanUnchecked.join(','),
      emiCustom: configState.emi.custom.join(','),
      emiUnchecked: emiUnchecked.join(',')
    });
    if (res.success) {
      showToast('Categories saved');
      populateCategorySelects();
    populateAccountSelects();
      markCatClean();
      renderCatList();
    } else { showToast('Error: '+(res.error||'Failed')); }
  } catch(e) { showToast('Connection error'); }
  if (btn) { btn.textContent = 'Save changes'; btn.disabled = false; }
}

// ── REPORTS ──
function setReportType(el,type) {
  document.querySelectorAll('.report-chip').forEach(c=>c.classList.remove('active'));
  el.classList.add('active'); currentReportType = type;
  document.getElementById('report-range-row').style.display = type==='range'?'block':'none';
}

function generateReport() {
  const now = new Date();
  let from,to,label;
  if (currentReportType==='daily') {
    from = new Date(now.getFullYear(),now.getMonth(),now.getDate()).getTime();
    to   = from + 86399999; label = 'Today';
  } else if (currentReportType==='weekly') {
    const day = now.getDay();
    const start = new Date(now); start.setDate(now.getDate()-day);
    from = new Date(start.getFullYear(),start.getMonth(),start.getDate()).getTime();
    to = from + 7*86400000 - 1; label = 'This Week';
  } else if (currentReportType==='monthly') {
    from = new Date(now.getFullYear(),now.getMonth(),1).getTime();
    to   = new Date(now.getFullYear(),now.getMonth()+1,0,23,59,59).getTime();
    label = now.toLocaleString('default',{month:'long',year:'numeric'});
  } else {
    const f=document.getElementById('report-from').value, t=document.getElementById('report-to').value;
    if(!f||!t){showToast('Select date range');return;}
    const [fy,fm,fd]=f.split('-'), [ty,tm,td]=t.split('-');
    from = new Date(+fy,+fm-1,+fd).getTime();
    to   = new Date(+ty,+tm-1,+td,23,59,59).getTime();
    label = `${fd}/${fm}/${fy} – ${td}/${tm}/${ty}`;
  }
  const fE = appData.expenses.filter(r=>{const ts=parseSheetDate(r['Date']);return ts>=from&&ts<=to;});
  const fI = appData.income.filter(r=>{const ts=parseSheetDate(r['Date']);return ts>=from&&ts<=to;});
  const totalExp = fE.reduce((s,r)=>s+Number(r['Expense Amount']||0),0);
  const totalInc = fI.reduce((s,r)=>s+Number(r['Income Amount']||0),0);
  const net = totalInc - totalExp;
  const expByCat={}, incByCat={};
  fE.forEach(r=>{const c=r['Category'];expByCat[c]=(expByCat[c]||0)+Number(r['Expense Amount']||0);});
  fI.forEach(r=>{const c=r['Category'];incByCat[c]=(incByCat[c]||0)+Number(r['Income Amount']||0);});
  reportData = { label, from, to, fE, fI, totalExp, totalInc, net, expByCat, incByCat };
  let html = `
    <div class="report-stat-row"><span class="report-stat-label">Period</span><span class="report-stat-val">${label}</span></div>
    <div class="report-stat-row"><span class="report-stat-label">Total Income</span><span class="report-stat-val" style="color:var(--green)">${fmt(totalInc)}</span></div>
    <div class="report-stat-row"><span class="report-stat-label">Total Expenses</span><span class="report-stat-val" style="color:var(--red)">${fmt(totalExp)}</span></div>
    <div class="report-stat-row"><span class="report-stat-label">Net Savings</span><span class="report-stat-val" style="color:${net>=0?'var(--green)':'var(--red)'}">${fmt(net)}</span></div>`;
  if (Object.keys(expByCat).length) {
    html += `<div style="margin:12px 0 6px;font-size:11px;font-weight:700;color:var(--text2);letter-spacing:1px;text-transform:uppercase">Expense Breakdown</div>`;
    html += Object.entries(expByCat).sort((a,b)=>b[1]-a[1]).map(([c,v])=>`<div class="report-stat-row"><span class="report-stat-label">${c}</span><span class="report-stat-val" style="color:var(--red)">${fmt(v)}</span></div>`).join('');
  }
  if (Object.keys(incByCat).length) {
    html += `<div style="margin:12px 0 6px;font-size:11px;font-weight:700;color:var(--text2);letter-spacing:1px;text-transform:uppercase">Income Breakdown</div>`;
    html += Object.entries(incByCat).sort((a,b)=>b[1]-a[1]).map(([c,v])=>`<div class="report-stat-row"><span class="report-stat-label">${c}</span><span class="report-stat-val" style="color:var(--green)">${fmt(v)}</span></div>`).join('');
  }
  document.getElementById('report-output').innerHTML = html;
  document.getElementById('report-export-btns').style.display = 'flex';
}

// ── CSV EXPORT ──
function exportCSV() {
  if (!reportData) { showToast('Generate a report first'); return; }
  const d = reportData;
  let csv = 'WALLET - FINANCIAL REPORT\n';
  csv += `Period,${d.label}
`;
  csv += `Total Income,${d.totalInc}
`;
  csv += `Total Expenses,${d.totalExp}
`;
  csv += `Net,${d.net}

`;
  csv += 'EXPENSES\nDate,Category,Description,Payment Mode,Amount,Remarks\n';
  d.fE.forEach(r=>{ csv+=`${fmtDisplay(r['Date'])},${r['Category']},${r['Description']},${r['Payment Mode']},${r['Expense Amount']},${r['Remarks']||'-'}
`; });
  csv += '\nINCOME\nDate,Category,Description,Payment Mode,Amount,Remarks\n';
  d.fI.forEach(r=>{ csv+=`${fmtDisplay(r['Date'])},${r['Category']},${r['Description']},${r['Payment Mode']},${r['Income Amount']},${r['Remarks']||'-'}
`; });
  const blob = new Blob([csv],{type:'text/csv'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `wallet-report-${d.label.replace(/[^a-z0-9]/gi,'-')}.csv`;
  a.click();
  showToast('CSV exported');
}

// ── PDF EXPORT ──
function exportPDF() {
  if (!reportData) { showToast('Generate a report first'); return; }
  const d = reportData;
  const theme = document.documentElement.getAttribute('data-theme') || 'light';
  const logoSrc = theme === 'dark' ? D_LOGO_SRC : L_LOGO_SRC;

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Wallet Report - ${d.label}</title>
<style>
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family: -apple-system, 'Segoe UI', sans-serif; background:#fff; color:#111; font-size:13px; }
  .page { max-width:720px; margin:0 auto; padding:40px 32px; }
  .header { display:flex; align-items:center; justify-content:space-between; padding-bottom:20px; border-bottom:2px solid #1a73e8; margin-bottom:24px; }
  .header-logo { height:36px; }
  .header-right { text-align:right; }
  .header-title { font-size:20px; font-weight:800; color:#1a73e8; }
  .header-period { font-size:12px; color:#6b7280; margin-top:3px; }
  .generated { font-size:11px; color:#adb5bd; margin-top:2px; }
  .summary-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:28px; }
  .summary-card { border-radius:12px; padding:14px 12px; text-align:center; }
  .sc-label { font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:.8px; margin-bottom:4px; }
  .sc-val { font-size:18px; font-weight:800; }
  .sc-income { background:#f0fdf4; } .sc-income .sc-val { color:#1e8e3e; }
  .sc-expense { background:#fef2f2; } .sc-expense .sc-val { color:#d93025; }
  .sc-net-pos { background:#eff6ff; } .sc-net-pos .sc-val { color:#1a73e8; }
  .sc-net-neg { background:#fef2f2; } .sc-net-neg .sc-val { color:#d93025; }
  .sc-label-c { color:#6b7280; }
  .section { margin-bottom:28px; }
  .section-title { font-size:14px; font-weight:700; color:#0f1117; margin-bottom:10px;
    padding:8px 12px; background:#f4f6fb; border-radius:8px; border-left:4px solid #1a73e8; }
  table { width:100%; border-collapse:collapse; }
  th { background:#1a73e8; color:#fff; padding:10px 12px; text-align:left; font-size:11px;
    font-weight:700; letter-spacing:.5px; text-transform:uppercase; }
  th:last-child { text-align:right; }
  td { padding:9px 12px; border-bottom:1px solid #f0f2f8; font-size:12px; vertical-align:top; }
  tr:last-child td { border-bottom:none; }
  tr:nth-child(even) td { background:#fafbff; }
  .amt-exp { color:#d93025; font-weight:600; text-align:right; }
  .amt-inc { color:#1e8e3e; font-weight:600; text-align:right; }
  .totals-row td { font-weight:700; background:#f4f6fb !important; border-top:2px solid #e2e5ef; }
  .breakdown-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  .breakdown-table th { background:#374151; }
  .footer { margin-top:32px; padding-top:16px; border-top:1px solid #e2e5ef;
    text-align:center; font-size:11px; color:#adb5bd; }
  /* Print action bar — hidden when printing */
  .print-bar { position:fixed; top:0; left:0; right:0; background:#1a73e8; color:#fff;
    display:flex; align-items:center; justify-content:space-between;
    padding:12px 20px; font-size:13px; font-weight:600; gap:12px; z-index:100; }
  .print-bar button { background:#fff; color:#1a73e8; border:none; border-radius:8px;
    padding:8px 18px; font-size:13px; font-weight:700; cursor:pointer; }
  .print-bar .close-btn { background:rgba(255,255,255,.2); color:#fff; }
  body { padding-top: 52px; }
  @media print {
    .print-bar { display:none !important; }
    body { padding-top:0; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  }
</style>
</head>
<body>
<div class="print-bar">
  <span>Wallet Report — ${d.label}</span>
  <div style="display:flex;gap:8px">
    <button onclick="window.print()">🖨️ Print / Save PDF</button>
    <button class="close-btn" onclick="window.close()">✕ Close</button>
  </div>
</div>
<div class="page">
  <div class="header">
    <img src="${window.location.origin}${window.location.pathname.replace('index.html','')}${logoSrc}" class="header-logo" alt="Wallet" onerror="this.style.display='none'">
    <div class="header-right">
      <div class="header-title">Financial Report</div>
      <div class="header-period">${d.label}</div>
      <div class="generated">Generated: ${new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})}</div>
    </div>
  </div>
  <div class="summary-grid">
    <div class="summary-card sc-income"><div class="sc-label sc-label-c">Income</div><div class="sc-val">₹${Number(d.totalInc).toLocaleString('en-IN')}</div></div>
    <div class="summary-card sc-expense"><div class="sc-label sc-label-c">Expenses</div><div class="sc-val">₹${Number(d.totalExp).toLocaleString('en-IN')}</div></div>
    <div class="summary-card ${d.net>=0?'sc-net-pos':'sc-net-neg'}"><div class="sc-label sc-label-c">Net</div><div class="sc-val">₹${Number(Math.abs(d.net)).toLocaleString('en-IN')}</div></div>
    <div class="summary-card" style="background:#f8f9ff"><div class="sc-label sc-label-c">Transactions</div><div class="sc-val" style="color:#1a73e8">${d.fE.length+d.fI.length}</div></div>
  </div>
  ${d.fE.length ? `
  <div class="section">
    <div class="section-title">Expenses</div>
    <table>
      <thead><tr><th>Date</th><th>Category</th><th>Description</th><th>Payment Mode</th><th>Amount</th></tr></thead>
      <tbody>
        ${d.fE.map(r=>`<tr><td>${fmtDisplay(r['Date'])}</td><td>${r['Category']}</td><td>${r['Description']}</td><td>${r['Payment Mode']}</td><td class="amt-exp">₹${Number(r['Expense Amount']).toLocaleString('en-IN')}</td></tr>`).join('')}
        <tr class="totals-row"><td colspan="4">Total Expenses</td><td class="amt-exp">₹${Number(d.totalExp).toLocaleString('en-IN')}</td></tr>
      </tbody>
    </table>
  </div>` : ''}
  ${d.fI.length ? `
  <div class="section">
    <div class="section-title">Income</div>
    <table>
      <thead><tr><th>Date</th><th>Category</th><th>Description</th><th>Payment Mode</th><th>Amount</th></tr></thead>
      <tbody>
        ${d.fI.map(r=>`<tr><td>${fmtDisplay(r['Date'])}</td><td>${r['Category']}</td><td>${r['Description']}</td><td>${r['Payment Mode']}</td><td class="amt-inc">₹${Number(r['Income Amount']).toLocaleString('en-IN')}</td></tr>`).join('')}
        <tr class="totals-row"><td colspan="4">Total Income</td><td class="amt-inc">₹${Number(d.totalInc).toLocaleString('en-IN')}</td></tr>
      </tbody>
    </table>
  </div>` : ''}
  ${Object.keys(d.expByCat).length||Object.keys(d.incByCat).length ? `
  <div class="section">
    <div class="section-title">Category Breakdown</div>
    <div class="breakdown-grid">
      ${Object.keys(d.expByCat).length ? `
      <div><table class="breakdown-table">
        <thead><tr><th>Expense Cat.</th><th>Amount</th></tr></thead>
        <tbody>${Object.entries(d.expByCat).sort((a,b)=>b[1]-a[1]).map(([c,v])=>`<tr><td>${c}</td><td class="amt-exp">₹${Number(v).toLocaleString('en-IN')}</td></tr>`).join('')}</tbody>
      </table></div>` : ''}
      ${Object.keys(d.incByCat).length ? `
      <div><table class="breakdown-table">
        <thead><tr><th>Income Cat.</th><th>Amount</th></tr></thead>
        <tbody>${Object.entries(d.incByCat).sort((a,b)=>b[1]-a[1]).map(([c,v])=>`<tr><td>${c}</td><td class="amt-inc">₹${Number(v).toLocaleString('en-IN')}</td></tr>`).join('')}</tbody>
      </table></div>` : ''}
    </div>
  </div>` : ''}
  <div class="footer">Wallet · Smart Finance Tracking · Report generated on ${new Date().toLocaleString('en-IN')}</div>
</div>
<` + `script>
  // On mobile, trigger print immediately; on desktop show the bar
  if (/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
    window.onload = () => setTimeout(() => window.print(), 300);
  }
<` + `/script>
</body></html>`;

  // Use blob URL instead of window.open('','_blank') to avoid popup blockers
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const win  = window.open(url, '_blank');
  if (!win || win.closed || typeof win.closed === 'undefined') {
    // Popup was blocked — fallback: download the HTML file directly
    const a = document.createElement('a');
    a.href = url;
    a.download = `wallet-report-${d.label.replace(/[^a-z0-9]/gi,'-')}.html`;
    a.click();
    showToast('Report downloaded — open in browser to print/save as PDF');
  } else {
    showToast('PDF ready — use Print / Save PDF button');
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ── EMI ADD TAB SWITCH ──
function switchEMIAddTab(tab) {
  document.querySelectorAll('#emi-add-tabs .sheet-tab').forEach((t,i) =>
    t.classList.toggle('active', ['new','progress'][i] === tab));
  document.getElementById('add-emi-form').style.display         = tab==='new'?'block':'none';
  document.getElementById('add-emi-progress-form').style.display = tab==='progress'?'block':'none';
  if (tab === 'progress') setupProgressFormConstraints();
}

function setupProgressFormConstraints() {
  // When total EMIs changes, update max for paid EMIs
  const totalEl = document.getElementById('prog-emi-total-count');
  const paidEl  = document.getElementById('prog-emi-paid');
  const totalAmtEl = document.getElementById('prog-emi-total');
  const emiAmtEl   = document.getElementById('prog-emi-amount');
  const startEl    = document.getElementById('prog-emi-start');
  const nextBillEl = document.getElementById('prog-emi-next-bill');
  const nextDueEl  = document.getElementById('prog-emi-next-due');

  // Set today as max for start date
  const today = todayISO();
  if (startEl) startEl.max = today;

  // EMI amount cannot exceed total amount
  if (totalAmtEl && emiAmtEl) {
    totalAmtEl.addEventListener('input', () => {
      emiAmtEl.max = totalAmtEl.value || '';
    });
    emiAmtEl.addEventListener('input', () => {
      const max = Number(totalAmtEl.value);
      if (max && Number(emiAmtEl.value) > max) emiAmtEl.value = max;
    });
  }

  // Paid EMIs cannot exceed total EMIs
  if (totalEl && paidEl) {
    totalEl.addEventListener('input', () => {
      paidEl.max = totalEl.value || '';
      if (Number(paidEl.value) > Number(totalEl.value)) paidEl.value = totalEl.value;
    });
  }

  // Next due must be >= next bill
  if (nextBillEl && nextDueEl) {
    nextBillEl.addEventListener('change', () => {
      nextDueEl.min = nextBillEl.value;
      if (nextDueEl.value && nextDueEl.value < nextBillEl.value) nextDueEl.value = nextBillEl.value;
    });
  }

  // Min next bill = today
  if (nextBillEl) nextBillEl.min = today;
  if (nextDueEl)  nextDueEl.min  = today;
}

// ── SUBMIT IN-PROGRESS EMI ──
async function submitProgressEMI() {
  const cat      = document.getElementById('prog-emi-cat').value;
  const desc     = document.getElementById('prog-emi-desc').value.trim();
  const totalAmt = document.getElementById('prog-emi-total').value;
  const emiAmt   = document.getElementById('prog-emi-amount').value;
  const totalN   = document.getElementById('prog-emi-total-count').value;
  const paidN    = document.getElementById('prog-emi-paid').value;
  const startD   = document.getElementById('prog-emi-start').value;
  const billDay  = document.getElementById('prog-emi-billday').value;
  const nextBill = document.getElementById('prog-emi-next-bill').value;
  const nextDue  = document.getElementById('prog-emi-next-due').value;
  const payMode  = document.getElementById('prog-emi-pm').value;
  const remarks  = document.getElementById('prog-emi-remarks').value || '-';
  if (!desc||!totalAmt||!emiAmt||!totalN||!paidN||!startD||!billDay||!nextBill||!nextDue) {
    showToast('Fill all required fields'); return;
  }
  const _totalN   = Number(totalN);
  const _paidN    = Number(paidN);
  const _totalAmt = Number(totalAmt);
  const _emiAmt   = Number(emiAmt);
  const _billDay  = Number(billDay);
  const remaining = _totalN - _paidN;

  // ── Numeric sanity ──
  if (_totalAmt <= 0)           { showToast('Total amount must be greater than 0'); return; }
  if (_emiAmt <= 0)             { showToast('EMI amount must be greater than 0'); return; }
  if (_emiAmt > _totalAmt)      { showToast('EMI amount cannot exceed total amount'); return; }
  if (_totalN < 1)              { showToast('Total EMIs must be at least 1'); return; }
  if (_paidN < 0)               { showToast('Already paid EMIs cannot be negative'); return; }
  if (_paidN > _totalN)         { showToast(`Already paid (${_paidN}) cannot exceed total EMIs (${_totalN})`); return; }
  if (_billDay < 1 || _billDay > 31) { showToast('Bill day must be between 1 and 31'); return; }

  // ── Date logic ──
  const startTs    = new Date(startD).getTime();
  const nowTs      = Date.now();
  const nextBillTs = new Date(nextBill).getTime();
  const nextDueTs  = new Date(nextDue).getTime();

  // Start date must not be in the future
  if (startTs > nowTs) { showToast('Start date cannot be in the future'); return; }

  // Months elapsed since start (accurate to month boundary)
  const startDate  = new Date(startD);
  const today      = new Date();
  const monthsElapsed = (today.getFullYear() - startDate.getFullYear()) * 12
    + (today.getMonth() - startDate.getMonth());

  // paidN must be ≤ months elapsed (cannot have paid EMIs that haven't come due yet)
  if (_paidN > monthsElapsed + 1) {
    showToast(`Only ~${monthsElapsed+1} month(s) have passed since ${fmtDisplay(startD)} — cannot have ${_paidN} paid EMIs`);
    return;
  }

  // Next bill date must be in future (at least today)
  if (nextBillTs < nowTs - 24*3600*1000) {
    showToast('Next Bill Date is in the past — it should be a future date'); return;
  }

  // Next due date must be >= next bill date
  if (nextDueTs < nextBillTs) {
    showToast('Next Due Date must be on or after Next Bill Date'); return;
  }
  const btn = document.querySelector('#add-emi-progress-form .btn-primary');
  btn.disabled = true; btn.textContent = 'Saving...';
  try {
    const res = await api({
      action: 'addProgressEMI', userId: currentUser.id,
      category: cat, description: desc,
      totalAmount: totalAmt, emiAmount: emiAmt,
      totalEMIs: totalN, paidEMIs: paidN,
      startDate: fmtDateForSheet(startD),
      billGenerateDate: billDay,
      nextBillDate: fmtDateForSheet(nextBill),
      nextDueDate: fmtDateForSheet(nextDue),
      paymentMode: payMode, remarks,
      status: remaining === 0 ? 'Closed' : 'Active'
    });
    if (res.success) {
      showToast('EMI added — '+res.emiId);
      document.getElementById('emi-add-overlay').classList.remove('open');
      await loadAllData();
    } else { showToast('Error: '+(res.error||'Failed')); }
  } catch(e) { showToast('Connection error'); }
  btn.disabled = false; btn.textContent = 'Add In-Progress EMI';
}

// ── BALANCE TOGGLE ──
function toggleBalance() {
  balanceHidden = !balanceHidden;
  // Intentionally NOT persisted — balance always starts hidden on fresh open
  updateEyeIcon();
  renderDashboard();
}

function updateEyeIcon() {
  const icon = document.getElementById('bal-eye-icon');
  if (!icon) return;
  // hidden = show crossed-eye (so user knows they can reveal)
  // visible = show open-eye (so user knows they can hide)
  if (balanceHidden) {
    icon.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  } else {
    icon.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  }
}

// ── TOAST ──
function showToast(msg,dur=2500){
  const t=document.getElementById('toast');
  t.textContent=msg;t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),dur);
}

document.getElementById('login-pass').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin();});
// ══════════════════════════════════════════════════════════════
// EMI MODULE
// ══════════════════════════════════════════════════════════════

let currentEMI = null; // active EMI for action sheet

// ── RENDER EMIs ──
function renderEMIs() {
  const emis = appData.emis || [];
  const active   = emis.filter(e => String(e['Status']) === 'Active');
  const overdue  = emis.filter(e => String(e['Status']) === 'Overdue');
  const closed   = emis.filter(e => String(e['Status']) === 'Closed');

  // Summary stats
  const allActive = active.concat(overdue);
  const totalDebt = allActive.reduce((s,e) => {
    const total = Number(e['Total Amount']||0);
    const paid  = Number(e['Paid EMIs']||0) * Number(e['EMI Amount']||0);
    return s + Math.max(0, total - paid);
  }, 0);
  const dueThisMonth = allActive.reduce((s,e) => s + Number(e['EMI Amount']||0), 0);
  const activeCount  = allActive.length;
  // Paid this month = sum of EMI payments in current month
  const now = new Date();
  const curMonthKey = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const paidThisMonth = (appData.emiPayments||[]).reduce((s,p) => {
    const pd = String(p['Paid Date']||'');
    const ts = parseSheetDate(pd);
    if (!ts) return s;
    const d = new Date(ts);
    const mk = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    return mk === curMonthKey ? s + Number(p['Amount']||0) : s;
  }, 0);
  document.getElementById('emi-total-debt').textContent   = fmt(totalDebt);
  document.getElementById('emi-due-month').textContent    = fmt(dueThisMonth);
  document.getElementById('emi-active-count').textContent = activeCount + ' active';
  const emiNumEl = document.getElementById('emi-active-num');
  if (emiNumEl) emiNumEl.textContent = activeCount;
  document.getElementById('emi-paid-month').textContent   = fmt(paidThisMonth);

  const el = document.getElementById('emis-list');
  if (!emis.length) { el.innerHTML = emptyState('No EMIs','Add your first EMI loan'); return; }

  let html = '';
  if (overdue.length) {
    html += `<div class="sec-title" style="color:var(--red)">Overdue</div>`;
    html += overdue.map(emiCardHTML).join('');
  }
  if (active.length) {
    html += `<div class="sec-title">Active</div>`;
    html += active.map(emiCardHTML).join('');
  }
  if (closed.length) {
    html += `<div class="sec-title">Closed</div>`;
    html += closed.map(emiCardHTML).join('');
  }
  el.innerHTML = html;
}

function emiCardHTML(e) {
  const status    = String(e['Status']);
  const paidEMIs  = Number(e['Paid EMIs']||0);
  const totalEMIs = Number(e['Total EMIs']||1);
  const remaining = Number(e['Remaining EMIs']||0);
  const totalAmt  = Number(e['Total Amount']||0);
  const emiAmt    = Number(e['EMI Amount']||0);
  const paidSoFar = paidEMIs * emiAmt;
  const debtLeft  = Math.max(0, totalAmt - paidSoFar);
  const desc      = String(e['Description']||'');
  const emiId     = String(e['EMI ID']||'');
  const cat       = String(e['Category']||'');
  const payMode   = String(e['Payment Mode']||'');
  const nextDue   = fmtDisplay(e['Next Due Date']);
  const nextBill  = fmtDisplay(e['Next Bill Date']);
  const billDay   = String(e['Bill Generate Date']||'');
  const isClosed  = status === 'Closed';
  const isOverdue = status === 'Overdue';

  const statusColor = isClosed ? 'var(--text3)' : isOverdue ? 'var(--red)' : 'var(--green-light)';
  const barColor    = isClosed ? 'var(--text3)' : isOverdue ? 'var(--red)' : 'var(--blue)';
  const cardBorder  = isOverdue ? 'border-left:3px solid var(--red)' : '';

  // Timeline dots — numbered circles
  const dots = [];
  for (let i = 1; i <= totalEMIs; i++) {
    let cls;
    if (i <= paidEMIs)              cls = 'emi-dot paid';
    else if (i === paidEMIs+1 && !isClosed) cls = 'emi-dot next';
    else                            cls = 'emi-dot upcoming';
    dots.push(`<div class="${cls}">${i}</div>`);
  }

  const key = 'emi_' + emiId;
  _entryRegistry[key] = {...e, _type:'emi', _emiId: emiId};

  return `<div class="emi-card" style="${cardBorder}" onclick="openEMIAction('${emiId}')">
    <div class="emi-card-top">
      <div class="emi-card-left">
        <div class="emi-icon">${emiId}</div>
        <div>
          <div class="emi-title">${desc}</div>
          <div class="emi-meta">${cat} · ${emiId} · ${payMode}</div>
        </div>
      </div>
      <div class="emi-badge" style="background:${isOverdue?'rgba(217,48,37,.15)':isClosed?'rgba(107,114,128,.12)':'rgba(52,168,83,.15)'};color:${statusColor}">${status}</div>
    </div>

    <div class="emi-progress-row">
      <span class="emi-prog-label">${paidEMIs} paid</span>
      <div class="emi-prog-bar-wrap">
        <div class="emi-prog-bar-bg">
          <div class="emi-prog-bar-fill" style="width:${Math.round((paidEMIs/totalEMIs)*100)}%;background:${barColor}"></div>
        </div>
      </div>
      <span class="emi-prog-label">${remaining} remaining</span>
    </div>

    <div class="emi-stats-grid">
      <div class="emi-stat"><div class="emi-stat-label">Total amount</div><div class="emi-stat-val">${fmt(totalAmt)}</div></div>
      <div class="emi-stat"><div class="emi-stat-label">Debt remaining</div><div class="emi-stat-val" style="color:${isOverdue?'var(--red)':'var(--blue)'}">${fmt(debtLeft)}</div></div>
      <div class="emi-stat"><div class="emi-stat-label">EMI amount</div><div class="emi-stat-val">${fmt(emiAmt)}</div></div>
      <div class="emi-stat"><div class="emi-stat-label">Paid so far</div><div class="emi-stat-val" style="color:var(--green)">${fmt(paidSoFar)}</div></div>
    </div>

    ${!isClosed ? `<div class="emi-bill-row">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
      <span>Bill on ${billDay} — Due</span>
      <span class="emi-due-date">${nextDue}</span>
    </div>` : ''}

    <div class="emi-timeline-wrap">
      <div class="emi-timeline">${dots.join('')}</div>
    </div>
    <div style="display:flex;justify-content:flex-end;padding:4px 12px 10px;border-top:1px solid var(--border)">
      <button onclick="event.stopPropagation();deleteEMIConfirm('${emiId}')"
        style="background:rgba(217,48,37,.08);border:1px solid rgba(217,48,37,.18);
        border-radius:8px;padding:6px 12px;cursor:pointer;color:var(--red);
        font-size:11px;font-weight:700;display:flex;align-items:center;gap:5px">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        Delete EMI
      </button>
    </div>
  </div>`;
}


// ── EMI ACTION SHEET ──
function openEMIAction(emiId) {
  currentEMI = appData.emis.find(e => String(e['EMI ID']).trim() === emiId);
  if (!currentEMI) return;
  const e = currentEMI;
  const status    = String(e['Status']);
  const paidEMIs  = Number(e['Paid EMIs']||0);
  const totalEMIs = Number(e['Total EMIs']||1);
  const isClosed  = status === 'Closed';
  const pct   = Math.round((paidEMIs/totalEMIs)*100);
  const color = isClosed?'var(--green)':status==='Overdue'?'var(--red)':'var(--blue)';

  document.getElementById('emi-action-header').innerHTML = `
    <div class="la-name">${e['Description']} <span style="font-size:12px;color:var(--text2);font-weight:500">(${e['EMI ID']})</span></div>
    <div class="la-meta">${e['Category']} · ${fmt(Number(e['EMI Amount']||0))}/month${isClosed?' · <span style="color:var(--green);font-weight:700">Fully Paid ✓</span>':''}</div>
    <div style="margin-top:10px;font-size:12px;color:var(--text2)">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px">
        <span>Total: ${fmt(Number(e['Total Amount']||0))}</span>
        <span>EMI: ${paidEMIs}/${totalEMIs}</span>
      </div>
      ${!isClosed?`<div style="display:flex;justify-content:space-between;margin-bottom:6px">
        <span>Next Bill: ${fmtDisplay(e['Next Bill Date'])}</span>
        <span>Due: ${fmtDisplay(e['Next Due Date'])}</span>
      </div>`:''}
    </div>
    <div class="la-prog-bar"><div class="la-prog-fill" style="width:${pct}%;background:${color}"></div></div>
    <div class="la-prog-text"><span>${pct}% paid</span><span style="color:${color}">${status}</span></div>`;

  if (isClosed) {
    // Closed: hide Pay/Miss tab, show History + Edit
    document.querySelectorAll('#emi-action-tabs .sheet-tab').forEach((t,i)=>{
      t.style.display = i===0?'none':'block';
      t.classList.toggle('active', i===1);
    });
    document.getElementById('emi-pay-form').style.display = 'none';
    document.getElementById('emi-history').style.display  = 'block';
    document.getElementById('emi-edit-form').style.display  = 'none';
    renderEMIHistory();
  } else {
    document.querySelectorAll('#emi-action-tabs .sheet-tab').forEach(t=>{ t.style.display='block'; });
    document.getElementById('emi-pay-date').value   = todayISO();
    document.getElementById('emi-pay-amount').value = e['EMI Amount'] || '';
    const payBtn  = document.getElementById('emi-pay-btn');
    const missBtn = document.getElementById('emi-miss-btn');
    payBtn.style.display  = 'block';
    missBtn.style.display = 'block';
    payBtn.textContent = status==='Overdue'
      ? `Pay Overdue EMI ${paidEMIs+1}/${totalEMIs}`
      : `Pay EMI ${paidEMIs+1}/${totalEMIs}`;
    switchEMITab('pay');
  }
  document.getElementById('emi-action-overlay').classList.add('open');
}

function switchEMITab(tab) {
  document.querySelectorAll('#emi-action-tabs .sheet-tab').forEach((t,i) => t.classList.toggle('active',['pay','history','edit'][i]===tab));
  document.getElementById('emi-pay-form').style.display = tab==='pay'?'block':'none';
  document.getElementById('emi-history').style.display = tab==='history'?'block':'none';
  document.getElementById('emi-edit-form').style.display = tab==='edit'?'block':'none';
  if (tab==='history') renderEMIHistory();
  if (tab==='edit') renderEMIEditForm();
}

function renderEMIEditForm() {
  const e = currentEMI;
  if (!e) return;
  const cats = getEMICategories();
  document.getElementById('ee-cat').innerHTML = cats
    .map(c => `<option ${c===e['Category']?'selected':''}>${c}</option>`).join('');
  document.getElementById('ee-desc').value = e['Description'] || '';
  document.getElementById('ee-total').value = e['Total Amount'] || '';
  document.getElementById('ee-emi-amt').value = e['EMI Amount'] || '';
  document.getElementById('ee-total-emis').value = e['Total EMIs'] || '';
  document.getElementById('ee-pm').value = e['Payment Mode'] || 'UPI';
  const rmk = e['Remarks'];
  document.getElementById('ee-remarks').value = (rmk && rmk !== '-') ? rmk : '';
}

async function saveEMIEdit() {
  const e = currentEMI;
  if (!e) return;
  const description = document.getElementById('ee-desc').value.trim();
  const category = document.getElementById('ee-cat').value;
  const totalAmount = document.getElementById('ee-total').value;
  const emiAmount = document.getElementById('ee-emi-amt').value;
  const totalEMIs = document.getElementById('ee-total-emis').value;
  const paymentMode = document.getElementById('ee-pm').value;
  const remarks = document.getElementById('ee-remarks').value || '-';
  const paidEMIs = Number(e['Paid EMIs'] || 0);
  if (!description || !totalAmount || !emiAmount || !totalEMIs) { showToast('Fill required fields'); return; }
  if (Number(totalEMIs) < paidEMIs) { showToast(`Total EMIs can't be less than ${paidEMIs} already paid`); return; }
  const btn = document.getElementById('ee-save-btn');
  btn.disabled = true; btn.textContent = 'Saving...';
  try {
    const res = await api({
      action: 'editEMI', userId: currentUser.id, emiId: String(e['EMI ID']).trim(),
      description, category, totalAmount, emiAmount, totalEMIs, paymentMode, remarks
    });
    if (res.success) {
      showToast('EMI updated');
      closeOverlay('emi-action-overlay');
      clearCache();
      await loadAllData();
    } else { showToast('Error: ' + (res.error || 'Failed')); }
  } catch(e2) { showToast('Connection error'); }
  btn.disabled = false; btn.textContent = 'Save Changes';
}

function renderEMIHistory() {
  const e = currentEMI;
  if (!e) return;
  const emiId = String(e['EMI ID']).trim();
  const payments = (appData.emiPayments||[]).filter(p => String(p['EMI ID']).trim() === emiId)
    .sort((a,b) => {
      const aNum = parseInt(String(a['EMI #']).split('/')[0]) || 0;
      const bNum = parseInt(String(b['EMI #']).split('/')[0]) || 0;
      return bNum - aNum;
    });
  const el = document.getElementById('emi-history-list');
  if (!payments.length) { el.innerHTML = '<div style="text-align:center;color:var(--text3);padding:20px">No payments yet</div>'; return; }
  el.innerHTML = payments.map(p => {
    const st = String(p['Status']||'');
    const stColor = st==='Paid'?'var(--green)':st==='Late'?'var(--yellow)':'var(--red)';
    return `<div class="loan-entry-item">
      <div>
        <div class="le-cat" style="color:${stColor}">EMI ${p['EMI #']} · ${st}</div>
        <div class="le-date">Bill: ${fmtDisplay(p['Bill Date'])} · Paid: ${fmtDisplay(p['Paid Date'])}</div>
        ${p['Remarks']&&p['Remarks']!=='-'?`<div class="le-date" style="color:var(--yellow)">${p['Remarks']}</div>`:''}
      </div>
      <div class="le-amt" style="color:${stColor}">${fmt(Number(p['Amount']||0))}</div>
    </div>`;
  }).join('');
}

async function submitEMIPay() {
  const e = currentEMI;
  if (!e) return;
  const remaining = Number(e['Remaining EMIs']||0);
  if (remaining <= 0) { showToast('All EMIs are already paid'); return; }
  const paidDate = document.getElementById('emi-pay-date').value;
  const payMode  = document.getElementById('emi-pay-mode').value;
  const remarks  = document.getElementById('emi-pay-remarks').value || '-';
  if (!paidDate) { showToast('Select payment date'); return; }

  // Fix 2: Block duplicate payment in same month
  const emiId = String(e['EMI ID']).trim();
  const paidMonthKey = paidDate.slice(0,7); // YYYY-MM
  const alreadyPaidThisMonth = (appData.emiPayments||[]).some(p => {
    if (String(p['EMI ID']).trim() !== emiId) return false;
    const pd = String(p['Paid Date']||'');
    const ts = parseSheetDate(pd);
    if (!ts) return false;
    const d = new Date(ts);
    const mk = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    return mk === paidMonthKey;
  });
  if (alreadyPaidThisMonth) {
    showToast('EMI already paid for this month'); return;
  }
  const btn = document.getElementById('emi-pay-btn');
  btn.disabled = true; btn.textContent = 'Saving...';
  try {
    const res = await api({
      action: 'payEMI', userId: currentUser.id,
      emiId: String(e['EMI ID']).trim(),
      paidDate: fmtDateForSheet(paidDate),
      paymentMode: payMode, remarks
    });
    if (res.success) {
      showToast(res.newStatus === 'Closed' ? 'EMI fully paid! 🎉' : 'Payment recorded');
      closeOverlay('emi-action-overlay');
      clearCache();
      await loadAllData();
    } else { showToast('Error: '+(res.error||'Failed')); }
  } catch(err) { showToast('Connection error'); }
  btn.disabled = false;
  if (currentEMI) btn.textContent = `Pay EMI`;
}

async function submitEMIMiss() {
  const e = currentEMI;
  if (!e) return;
  const missNum = Number(e['Paid EMIs']||0)+1;
  showConfirm(`Mark EMI ${missNum}/${e['Total EMIs']} as Missed?\nNo expense will be recorded.`, async () => {
    const btn = document.getElementById('emi-miss-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
    try {
      const res = await api({ action:'markEMIMissed', userId:currentUser.id, emiId:String(e['EMI ID']).trim() });
      if (res.success) { showToast('Marked as missed'); closeOverlay('emi-action-overlay'); await loadAllData(); }
      else { showToast('Error: '+(res.error||'Failed')); }
    } catch(err) { showToast('Connection error'); }
    if (btn) { btn.disabled = false; btn.textContent = 'Mark as Missed'; }
  });
}


// ── ADD NEW EMI FORM ──
async function submitNewEMI() {
  const startDate  = document.getElementById('new-emi-start').value;
  const paidDate   = document.getElementById('new-emi-paid').value;
  const category   = document.getElementById('new-emi-cat').value;
  const desc       = document.getElementById('new-emi-desc').value.trim();
  const totalAmt   = document.getElementById('new-emi-total').value;
  const emiAmt     = document.getElementById('new-emi-amount').value;
  const totalEMIs  = document.getElementById('new-emi-count').value;
  const billDay    = document.getElementById('new-emi-billday').value;
  const payMode    = document.getElementById('new-emi-pm').value;
  const remarks    = document.getElementById('new-emi-remarks').value || '-';
  if (!startDate||!paidDate||!desc||!totalAmt||!emiAmt||!billDay) {
    showToast('Fill all required fields'); return;
  }
  if (!totalEMIs || Number(totalEMIs) < 1) {
    showToast('Enter Total Amount and EMI Amount to auto-calculate EMIs'); return;
  }
  // Numeric validations
  const _totalAmt = Number(totalAmt), _emiAmt = Number(emiAmt), _totalEMIs = Number(totalEMIs);
  const _billDay  = Number(billDay);
  if (_totalAmt <= 0)          { showToast('Total amount must be greater than 0'); return; }
  if (_emiAmt <= 0)            { showToast('EMI amount must be greater than 0'); return; }
  if (_emiAmt > _totalAmt)     { showToast('EMI amount cannot exceed total amount'); return; }
  if (_totalEMIs < 1)          { showToast('Total EMIs must be at least 1'); return; }
  if (_billDay < 1 || _billDay > 31) { showToast('Bill day must be between 1 and 31'); return; }
  // Date validations
  const startTs = new Date(startDate).getTime();
  const paidTs  = new Date(paidDate).getTime();
  if (paidTs < startTs) { showToast('First payment date cannot be before start date'); return; }
  // Paid date must be in current or future month (not past month)
  const now = new Date();
  const curMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  if (paidTs < curMonthStart) { showToast('First payment date cannot be in a past month'); return; }
  const btn = document.querySelector('#add-emi-form .btn-primary');
  btn.disabled = true; btn.textContent = 'Saving...';
  try {
    const res = await api({
      action:'addEMI', userId:currentUser.id,
      startDate:fmtDateForSheet(startDate),
      paidDate:fmtDateForSheet(paidDate),
      category, description:desc,
      totalAmount:totalAmt, emiAmount:emiAmt,
      totalEMIs, billGenerateDate:billDay,
      paymentMode:payMode, remarks
    });
    if (res.success) {
      showToast('EMI added — '+res.emiId);
      document.getElementById('emi-add-overlay').classList.remove('open');
      clearEMIForm();
      await loadAllData();
    } else { showToast('Error: '+(res.error||'Failed')); }
  } catch(err) { showToast('Connection error'); }
  btn.disabled = false; btn.textContent = 'Add EMI';
}

function clearEMIForm() {
  ['new-emi-start','new-emi-paid','new-emi-desc','new-emi-total','new-emi-amount','new-emi-count','new-emi-billday','new-emi-remarks'].forEach(id => {
    const el = document.getElementById(id); if(el) el.value = '';
  });
}

// Populate EMI category select
function populateEMICatSelect() {
  const cats = getEMICategories();
  fillSelect('new-emi-cat', cats);
  const progCat = document.getElementById('prog-emi-cat');
  if (progCat) fillSelect('prog-emi-cat', cats);
}
function getEMICategories() {
  const active = DEFAULT_EMI.filter(c => configState.emi.checked.has(c));
  return [...active, ...configState.emi.custom];
}



// Detect if an expense/income entry was auto-generated by a Loan or EMI
function isAutoEntry(r) {
  const cat  = String(r._cat || r['Category'] || '');
  const desc = String(r._desc || r['Description'] || '');
  const loanCats = ['Lent','Borrowed','Collected','Repaid'];
  if (loanCats.includes(cat)) return true;
  // EMI entries: description starts with "EM1 - " or "EM2 - " pattern
  if (/^EM\d+\s*-/.test(desc)) return true;
  return false;
}

// ── CUSTOM CONFIRM DIALOG ──
let _confirmCallback = null;
function showConfirm(msg, onOk, okLabel = 'Delete') {
  _confirmCallback = onOk;
  document.getElementById('confirm-msg').textContent = msg;
  const okBtn = document.getElementById('confirm-ok-btn');
  if (okBtn) okBtn.textContent = okLabel;
  document.getElementById('confirm-overlay').classList.add('open');
}
function confirmOK() {
  document.getElementById('confirm-overlay').classList.remove('open');
  if (_confirmCallback) { _confirmCallback(); _confirmCallback = null; }
}
function confirmCancel() {
  document.getElementById('confirm-overlay').classList.remove('open');
  _confirmCallback = null;
}

// ══════════════════════════════════════════════════════════════
// ENTRY DETAIL / EDIT / DELETE
// ══════════════════════════════════════════════════════════════

let currentEntryDetail = null;
let entryEditMode = false;

function openEntryDetail(key) {
  const r = (typeof key === 'string') ? _entryRegistry[key] : key;
  if (!r) { showToast('Could not load entry'); return; }
  currentEntryDetail = r;
  entryEditMode = false;
  renderEntryDetail();
  document.getElementById('entry-detail-overlay').classList.add('open');
}

function renderEntryDetail() {
  const r = currentEntryDetail;
  const isInc = r._type === 'income';
  const color  = isInc ? 'var(--green)' : 'var(--red)';
  const bgClr  = isInc ? 'rgba(52,168,83,.12)' : 'rgba(234,67,53,.12)';
  const sign   = isInc ? '+' : '-';
  const amt    = r._amt || (isInc ? r['Income Amount'] : r['Expense Amount']) || 0;
  const remarks = r['Remarks'] || r.Remarks || '-';
  const pm     = r._pm  || r['Payment Mode'] || '';
  const date   = fmtDisplay(r._date || r['Date']);
  const cat    = r._cat || r['Category'] || '';
  const desc   = r._desc || r['Description'] || '';
  const type   = String(r._type||'').charAt(0).toUpperCase() + String(r._type||'').slice(1);

  const header  = document.getElementById('entry-detail-header');
  const body    = document.getElementById('entry-detail-body');
  const editForm= document.getElementById('entry-edit-form');

  // Amount header
  header.innerHTML = `
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:16px">
      <div style="width:48px;height:48px;border-radius:14px;background:${bgClr};
        display:flex;align-items:center;justify-content:center;flex-shrink:0">
        ${isInc
          ? `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>`
          : `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2"><polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/></svg>`}
      </div>
      <div>
        <div style="font-size:22px;font-weight:800;color:${color};letter-spacing:-.5px">${sign}${fmt(amt)}</div>
        <div style="font-size:12px;color:var(--text2);margin-top:2px">${cat} · ${date}</div>
      </div>
    </div>
    ${isAutoEntry(r) ? `
    <div style="background:rgba(249,171,0,.1);border:1px solid rgba(249,171,0,.25);border-radius:10px;
      padding:10px 14px;font-size:12px;color:var(--yellow);margin-bottom:16px;line-height:1.5">
      <strong>Auto-generated entry</strong> — created by a Loan or EMI transaction.
      To modify, edit the original Loan or EMI record instead.
    </div>` : `
    <div class="detail-action-bar">
      <button class="detail-action-btn detail-edit-btn" onclick="toggleEntryEdit()">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        Edit
      </button>
      <button class="detail-action-btn detail-delete-btn" onclick="deleteEntry()">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
        Delete
      </button>
    </div>`}`;

  body.innerHTML = `
    <div class="detail-row"><span class="detail-label">Description</span><span class="detail-val">${desc}</span></div>
    <div class="detail-row"><span class="detail-label">Category</span><span class="detail-val">${cat}</span></div>
    <div class="detail-row"><span class="detail-label">Date</span><span class="detail-val">${date}</span></div>
    <div class="detail-row"><span class="detail-label">Amount</span><span class="detail-val" style="color:${color};font-weight:800">${sign}${fmt(amt)}</span></div>
    <div class="detail-row"><span class="detail-label">Payment Mode</span><span class="detail-val">${pm}</span></div>
    <div class="detail-row"><span class="detail-label">Remarks</span><span class="detail-val" style="color:${remarks==='-'?'var(--text3)':'var(--text)'}">${remarks}</span></div>
    <div class="detail-row"><span class="detail-label">Type</span><span class="detail-val">${type}</span></div>`;

  body.style.display = 'block';
  editForm.style.display = 'none';
}

function toggleEntryEdit() {
  const r = currentEntryDetail;
  const isInc = r._type === 'income';
  const body = document.getElementById('entry-detail-body');
  const editForm = document.getElementById('entry-edit-form');

  if (editForm.style.display === 'block') {
    // Switch back to view
    renderEntryDetail();
    return;
  }

  // Populate edit form
  const amt = r._amt || (isInc ? r['Income Amount'] : r['Expense Amount']) || 0;
  const dateRaw = r._date || r['Date'] || '';
  const remarks = r['Remarks'] || r.Remarks || '';
  const pm = r._pm || r['Payment Mode'] || '';
  const desc = r._desc || r['Description'] || '';

  // Convert DD/MM/YYYY to YYYY-MM-DD for input[type=date]
  let isoDate = '';
  if (dateRaw) {
    const ts = parseSheetDate(dateRaw);
    if (ts) {
      const d = new Date(ts);
      isoDate = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }
  }

  const cats = isInc ? getActiveCategories('income') : getActiveCategories('expense');
  const catOpts = cats.map(c => `<option ${c===r._cat?'selected':''}>${c}</option>`).join('');
  const pmOpts = ['UPI','Cash','Card','Net Banking','Cheque','Wallet','Auto Debit']
    .map(p => `<option ${p===pm?'selected':''}>${p}</option>`).join('');
  const curAcct = String(r['Account'] || '').trim();
  const acctOpts = '<option value="">— No account —</option>' + accountsList()
    .map(a => `<option value="${esc(a.name)}" ${a.name===curAcct?'selected':''}>${esc(a.name)}</option>`).join('');

  editForm.innerHTML = `
    <div class="form-group"><div class="field-label">Date</div><input type="date" id="edit-date" value="${isoDate}"></div>
    <div class="form-group"><div class="field-label">Amount ₹</div><input type="number" id="edit-amount" value="${amt}" inputmode="decimal"></div>
    <div class="form-group"><div class="field-label">Category</div><select id="edit-cat">${catOpts}</select></div>
    <div class="form-group"><div class="field-label">Description</div><input type="text" id="edit-desc" value="${desc}"></div>
    <div class="form-group"><div class="field-label">Payment Mode</div><select id="edit-pm">${pmOpts}</select></div>
    <div class="form-group account-field" style="display:${hasAccounts()?'block':'none'}"><div class="field-label">Account</div><select id="edit-account">${acctOpts}</select></div>
    <div class="form-group"><div class="field-label">Remarks</div><input type="text" id="edit-remarks" value="${remarks==='­'?'':remarks}"></div>
    <button class="btn btn-primary" onclick="saveEntryEdit()">Save Changes</button>
    <button class="btn btn-ghost" onclick="renderEntryDetail()" style="margin-top:8px">Cancel</button>`;

  body.style.display = 'none';
  editForm.style.display = 'block';
}

async function saveEntryEdit() {
  const r = currentEntryDetail;
  const isInc = r._type === 'income';
  const newDate   = fmtDateForSheet(document.getElementById('edit-date').value);
  const newAmt    = document.getElementById('edit-amount').value;
  const newCat    = document.getElementById('edit-cat').value;
  const newDesc   = document.getElementById('edit-desc').value.trim();
  const newPM     = document.getElementById('edit-pm').value;
  const newRemarks = document.getElementById('edit-remarks').value || '-';
  if (!newAmt || !newDesc) { showToast('Fill required fields'); return; }
  const btn = document.querySelector('#entry-edit-form .btn-primary');
  btn.disabled = true; btn.textContent = 'Saving...';
  try {
    const res = await api({
      action: isInc ? 'editIncome' : 'editExpense',
      userId: currentUser.id,
      rowIndex: r._rowIndex,
      date: newDate, amount: newAmt,
      category: newCat, description: newDesc,
      paymentMode: newPM, remarks: newRemarks,
      account: (document.getElementById('edit-account')||{}).value || ''
    });
    if (res.success) {
      showToast('Entry updated');
      closeOverlay('entry-detail-overlay');
      await loadAllData();
    } else { showToast('Error: '+(res.error||'Failed')); }
  } catch(e) { showToast('Connection error'); }
  btn.disabled = false; btn.textContent = 'Save Changes';
}

async function deleteEntry() {
  const r = currentEntryDetail;
  const isInc = r._type === 'income';
  const amt = r._amt || (isInc ? r['Income Amount'] : r['Expense Amount']) || 0;
  const desc = r._desc || r['Description'] || 'this entry';
  showConfirm(`Delete "${desc}" (${fmt(amt)})?
This cannot be undone.`, async () => {
    try {
      const res = await api({
        action: isInc ? 'deleteIncome' : 'deleteExpense',
        userId: currentUser.id,
        rowIndex: r._rowIndex
      });
      if (res.success) {
        showToast('Entry deleted');
        closeOverlay('entry-detail-overlay');
        await loadAllData();
      } else { showToast('Error: '+(res.error||'Failed')); }
    } catch(e) { showToast('Connection error'); }
  });
}

// ══════════════════════════════════════════════════════════════
// DELETE LOAN / EMI (removes all related rows from all sheets)
// ══════════════════════════════════════════════════════════════

function deleteLoanConfirm(loanId) {
  const l = appData.loanSummary.find(x => x.loanId === loanId);
  const name = l ? l.person : loanId;
  showConfirm(
    `Delete loan "${name}" (${loanId})?\n\nThis will remove ALL entries for this loan from Loans, Expenses, and Income sheets. This cannot be undone.`,
    async () => { await deleteLoan(loanId); }
  );
}

async function deleteLoan(loanId) {
  try {
    const res = await api({ action: 'deleteLoanById', userId: currentUser.id, loanId });
    if (res.success) {
      showToast(`Loan ${loanId} deleted`);
      await loadAllData();
    } else { showToast('Error: ' + (res.error || 'Failed')); }
  } catch(e) { showToast('Connection error'); }
}

function deleteEMIConfirm(emiId) {
  const e = appData.emis.find(x => String(x['EMI ID']).trim() === emiId);
  const name = e ? String(e['Description']) : emiId;
  showConfirm(
    `Delete EMI "${name}" (${emiId})?\n\nThis will remove ALL entries for this EMI from EMI, EMI Payments, and Expenses sheets. This cannot be undone.`,
    async () => { await deleteEMI(emiId); }
  );
}

async function deleteEMI(emiId) {
  try {
    const res = await api({ action: 'deleteEMIById', userId: currentUser.id, emiId });
    if (res.success) {
      showToast(`EMI ${emiId} deleted`);
      await loadAllData();
    } else { showToast('Error: ' + (res.error || 'Failed')); }
  } catch(e) { showToast('Connection error'); }
}

// ══════════════════════════════════════════════════════════════
// MISSING FUNCTIONS — restored
// ══════════════════════════════════════════════════════════════

// ── ENTRY REGISTRY (keyed store for detail/edit/delete) ──
const _entryRegistry = {};

// ── SCREEN SWITCHING ──
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ── PAGE SWITCHING ──
function switchPage(page) {
  currentPage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.page === page);
  });
  if (page === 'emis') {
    // Show FAB only for EMI page with EMI add overlay
    document.querySelector('.fab').onclick = () => openEMIAddModal();
  } else {
    document.querySelector('.fab').onclick = () => openAddModal();
  }
}

// ── OVERLAY HELPERS ──
function closeOverlay(id, event) {
  if (event && event.target !== document.getElementById(id)) return;
  document.getElementById(id).classList.remove('open');
}

function openAddModal() {
  // Open the tab matching the current page
  const tabMap = { loans: 'loan' };
  const tab = tabMap[currentPage] || (currentPage === 'summary' ? summaryType : 'expense');
  switchAddTab(tab);
  document.getElementById('exp-date').value  = todayISO();
  document.getElementById('inc-date').value  = todayISO();
  document.getElementById('loan-date').value = todayISO();
  document.getElementById('add-overlay').classList.add('open');
}

function openEMIAddModal() {
  document.getElementById('emi-add-overlay').classList.add('open');
  switchEMIAddTab('new');
  document.getElementById('new-emi-start').value = todayISO();
  document.getElementById('new-emi-paid').value = todayISO();
  populateEMICatSelect();
}

// ══════════════════════════════════════════════════════════════
// SETTINGS — full page with a sub-page stack
// ══════════════════════════════════════════════════════════════
const APP_VERSION = '1.2.0';
let _settingsOpen  = false;
let settingsStack  = [];   // e.g. ['main','categories']

function openProfile() { openSettings(); }   // avatar single-tap entry point

function openSettings() {
  settingsStack = ['main'];
  showSPage('main');
  renderSettings();
  document.getElementById('settings-screen').classList.add('open');
  document.body.classList.add('no-scroll');
  _settingsOpen = true;
  pushSettingsState();
}

function openSubPage(name) {
  settingsStack.push(name);
  showSPage(name);
  if (name === 'accounts')   renderAccountRows('settings-accounts-list');
  if (name === 'categories') { catTab = 'expense'; syncCatSegments(); renderCatList(); markCatClean(); }
  if (name === 'widgets')    renderWidgets();
  if (name === 'bank')       renderAccountsPage();
  pushSettingsState();
}

// Back arrow inside a sub-page. Goes through history so the hardware back
// button and the on-screen arrow behave identically.
function settingsBack() {
  try { history.back(); } catch(e) { popSettingsPage(); }
}

function popSettingsPage() {
  if (settingsStack.length > 1) {
    settingsStack.pop();
    showSPage(settingsStack[settingsStack.length - 1]);
    if (settingsStack.length === 1) renderSettings();
    return true;
  }
  return false;
}

function showSPage(name) {
  document.querySelectorAll('#settings-screen .spage').forEach(el =>
    el.classList.toggle('active', el.id === 'spage-' + name));
  const active = document.getElementById('spage-' + name);
  const sc = active && active.querySelector('.spage-scroll');
  if (sc) sc.scrollTop = 0;
}

function pushSettingsState() {
  try { history.pushState({ walletSettings: settingsStack.length }, ''); } catch(e) {}
}

// Programmatic close (logout, account switch...) — unwinds every state we pushed
function closeSettings() {
  if (!_settingsOpen) return;
  const depth = settingsStack.length;
  _settingsOpen = false;
  settingsStack = [];
  document.getElementById('settings-screen').classList.remove('open');
  document.body.classList.remove('no-scroll');
  try { history.go(-depth); } catch(e) {}
}

window.addEventListener('popstate', () => {
  if (!_settingsOpen) return;
  if (popSettingsPage()) return;
  _settingsOpen = false;
  settingsStack = [];
  document.getElementById('settings-screen').classList.remove('open');
  document.body.classList.remove('no-scroll');
});

const THEME_LABELS = { light:'Light', dark:'Dark', amoled:'AMOLED', glass:'Glass' };

function renderSettings() {
  const u = currentUser || {};
  document.getElementById('settings-avatar').textContent = (u.username || '?').charAt(0).toUpperCase();
  document.getElementById('settings-name').textContent   = u.username || 'User';
  document.getElementById('settings-email').textContent  = u.email || '';
  document.getElementById('settings-version').textContent = APP_VERSION;

  const tags = [`<span class="settings-tag">ID ${esc(String(u.id || '—'))}</span>`];
  if (accounts.length > 1) tags.push(`<span class="settings-tag">${accounts.length} accounts</span>`);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  if (standalone) tags.push('<span class="settings-tag">Installed</span>');
  document.getElementById('settings-tags').innerHTML = tags.join('');

  document.getElementById('settings-accounts-value').textContent =
    accounts.length > 1 ? `${accounts.length} accounts` : (u.username || '1');

  const catTotal = ['expense','income','loan','emi']
    .reduce((n,t) => n + getConfigList(t).length, 0);
  document.getElementById('settings-cat-value').textContent = catTotal + ' active';

  const nAcct = accountsList().length;
  document.getElementById('settings-bank-value').textContent =
    nAcct ? (nAcct === 1 ? accountsList()[0].name : nAcct + ' accounts') : 'None yet';

  const theme = document.documentElement.getAttribute('data-theme') || 'light';
  document.getElementById('settings-theme-value').textContent = THEME_LABELS[theme] || 'Light';

  const last = getLastSync();
  document.getElementById('settings-sync-value').textContent = last ? relativeTime(last) : '—';

  const others = accounts.filter(a => !currentUser || String(a.id) !== String(currentUser.id));
  document.getElementById('settings-logout-hint').textContent = others.length
    ? `Switches to ${others[0].username}`
    : 'Sign out of this account';
  document.getElementById('settings-logout-all-row').style.display = accounts.length > 1 ? 'flex' : 'none';
  document.getElementById('settings-install-row').style.display = window._installPrompt ? 'flex' : 'none';

  document.getElementById('pref-hide-balance').checked = !!prefs.hideBalance;
  document.getElementById('pref-decimals').checked     = !!prefs.decimals;
  document.getElementById('pref-haptics').checked      = !!prefs.haptics;
}

function getLastSync() {
  try {
    const raw = localStorage.getItem('wallet_cache_' + (currentUser && currentUser.id));
    return raw ? (JSON.parse(raw).cachedAt || 0) : 0;
  } catch(e) { return 0; }
}

function relativeTime(ts) {
  const min = Math.floor(Math.max(0, Date.now() - ts) / 60000);
  if (min < 1)  return 'just now';
  if (min < 60) return `${min} min ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

async function syncNow() {
  showToast('Syncing...');
  clearCache();
  await refreshFromAPI();
  renderSettings();
  showToast('Up to date');
}

function clearCacheConfirm() {
  showConfirm(
    'Clear the offline cache for this account?\n\nNothing on the server is touched — the app just re-downloads everything next time.',
    async () => { clearCache(); showToast('Cache cleared'); await refreshFromAPI(); renderSettings(); },
    'Clear'
  );
}

function triggerInstall() {
  const p = window._installPrompt;
  if (!p) { showToast('Install is not available right now'); return; }
  p.prompt();
  p.userChoice.then(r => {
    if (r.outcome === 'accepted') { window._installPrompt = null; showToast('Installing Wallet...'); renderSettings(); }
  }).catch(() => {});
}

// ══════════════════════════════════════════════════════════════
// WIDGETS & HOME SCREEN SHORTCUTS
// The shortcuts live in manifest.json. Long-pressing the installed app icon
// exposes them, and on Android each one can be dragged onto the home screen
// as its own icon. handleLaunchAction() below catches the ?action= they open.
// ══════════════════════════════════════════════════════════════
let _widgetIndex = 0;
let _railBound   = false;

const WIDGET_TITLES = ['Balance', 'Quick Add', 'This Month'];

function widgetCards() {
  const bal   = calcBalance();
  const month = monthTotals();
  const pct   = month.income > 0 ? Math.min(100, Math.round(month.expense / month.income * 100)) : 0;
  const name  = (currentUser && currentUser.username) || 'Wallet';

  return [
    `<div class="wgt wgt-balance">
       <div class="wgt-top"><span class="wgt-brand">Wallet</span><span class="wgt-user">${esc(name)}</span></div>
       <div class="wgt-label">Balance</div>
       <div class="wgt-amount">${fmt(bal)}</div>
       <div class="wgt-split">
         <div><span class="wgt-dot up"></span>In ${fmt(month.income)}</div>
         <div><span class="wgt-dot down"></span>Out ${fmt(month.expense)}</div>
       </div>
     </div>`,
    `<div class="wgt wgt-quick">
       <div class="wgt-top"><span class="wgt-brand">Quick add</span></div>
       <div class="wgt-actions">
         <div class="wgt-act red"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><line x1="5" y1="12" x2="19" y2="12"/></svg><span>Expense</span></div>
         <div class="wgt-act green"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg><span>Income</span></div>
         <div class="wgt-act purple"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg><span>Loan</span></div>
         <div class="wgt-act blue"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg><span>Report</span></div>
       </div>
     </div>`,
    `<div class="wgt wgt-month">
       <div class="wgt-top"><span class="wgt-brand">This month</span><span class="wgt-user">${esc(monthLabel())}</span></div>
       <div class="wgt-amount sm">${fmt(month.expense)}<span class="wgt-of">of ${fmt(month.income)}</span></div>
       <div class="wgt-bar"><div class="wgt-bar-fill" style="width:${pct}%"></div></div>
       <div class="wgt-split"><div>${pct}% of income spent</div><div>${fmt(Math.max(0, month.income - month.expense))} left</div></div>
     </div>`
  ];
}

function renderWidgets() {
  const rail = document.getElementById('widget-rail');
  if (!rail) return;
  const cards = widgetCards();

  rail.innerHTML = cards.map((c, i) =>
    `<div class="widget-slide">${c}<div class="widget-caption">${WIDGET_TITLES[i]}</div></div>`).join('');

  // Native horizontal swipe with scroll snapping — the dots just follow along
  if (!_railBound) {
    _railBound = true;
    let raf = null;
    rail.addEventListener('scroll', () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        const i = Math.round(rail.scrollLeft / Math.max(1, rail.clientWidth));
        if (i !== _widgetIndex) { _widgetIndex = i; paintDots(); }
      });
    }, { passive: true });
  }
  paintDots();
  renderWidgetSteps();
}

function paintDots() {
  const dots = document.getElementById('widget-dots');
  if (!dots) return;
  dots.innerHTML = WIDGET_TITLES.map((_, i) =>
    `<div class="widget-dot ${i === _widgetIndex ? 'active' : ''}" onclick="setWidget(${i})"></div>`).join('');
}

function setWidget(i) {
  const rail = document.getElementById('widget-rail');
  if (!rail) return;
  _widgetIndex = i;
  rail.scrollTo({ left: i * rail.clientWidth, behavior: 'smooth' });
  paintDots();
}

// Step-by-step guide, written for whatever the person is actually running on
function renderWidgetSteps() {
  const el = document.getElementById('widget-steps');
  if (!el) return;
  const ua = navigator.userAgent;
  const isAndroid = /Android/i.test(ua);
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  const installed = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;

  const step = (n, title, body) =>
    `<div class="wstep"><div class="wstep-num">${n}</div>
       <div><div class="wstep-title">${title}</div><div class="wstep-body">${body}</div></div></div>`;

  let steps = '';
  let action = '';

  if (!installed) {
    steps =
      step(1, 'Install Wallet', 'Chrome menu (⋮) → <b>Add to Home screen</b> → <b>Install</b>. This creates a real app icon, not a bookmark.') +
      step(2, 'Long-press the icon', 'Once installed, press and hold the Wallet icon on your home screen.') +
      step(3, 'Drag out a shortcut', 'The four shortcuts below pop up. Drag any one onto an empty spot to pin it as its own icon.');
    if (window._installPrompt) {
      action = `<button class="btn btn-primary" style="margin-top:12px" onclick="triggerInstall()">Install Wallet now</button>`;
    }
  } else if (isAndroid) {
    steps =
      step(1, 'Long-press the Wallet icon', 'Press and hold the app icon on your home screen or in the app drawer.') +
      step(2, 'Pick a shortcut', 'Add Expense, Add Income, Loans and Reports appear above the icon.') +
      step(3, 'Drag it out', 'Hold the shortcut and drag it onto the home screen. It becomes its own tappable icon that opens straight to that screen.');
    action =
      `<div class="wnote">
         <strong>Shortcuts not showing?</strong>
         Android caches the app definition from when you installed it. Uninstall Wallet from your home screen, reload this page in Chrome, and install it again — the shortcuts appear immediately after a fresh install.
       </div>`;
  } else if (isIOS) {
    steps =
      step(1, 'Add to Home Screen', 'Share button → <b>Add to Home Screen</b>.') +
      step(2, 'Use the in-app quick actions', 'iOS does not expose web app shortcuts, so the + button inside Wallet is the fastest route.');
  } else {
    steps =
      step(1, 'Install Wallet', 'Click the install icon in the address bar.') +
      step(2, 'Right-click the icon', 'The shortcuts appear in the context menu from your taskbar or app list.');
  }

  el.innerHTML = `<div class="settings-card settings-card-pad wsteps">${steps}</div>${action}`;

  const callout = document.getElementById('widget-callout');
  if (callout) {
    callout.innerHTML =
      `<strong>Why not a live widget?</strong>
       Drawing a card on the Android launcher is something only apps installed from the Play Store can do. Wallet runs in Chrome, so it can't paint pixels outside its own window. Pinned shortcuts are the supported equivalent — one tap, straight to the screen you want. The previews above show where each shortcut lands.`;
  }
}

// All-time balance, using the same field names as the dashboard
function calcBalance() {
  const inc = appData.income.reduce((s,r)   => s + Number(r['Income Amount']  || 0), 0);
  const exp = appData.expenses.reduce((s,r) => s + Number(r['Expense Amount'] || 0), 0);
  return inc - exp;
}

function monthTotals() {
  const { from, to } = getDateRange('month');
  const within = r => { const ts = parseSheetDate(r['Date']); return ts >= from && ts <= to; };
  return {
    income:  appData.income.filter(within).reduce((s,r)   => s + Number(r['Income Amount']  || 0), 0),
    expense: appData.expenses.filter(within).reduce((s,r) => s + Number(r['Expense Amount'] || 0), 0)
  };
}

function monthLabel() {
  const now = new Date();
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${names[now.getMonth()]} ${now.getFullYear()}`;
}

// Runs once at startup — routes ?action=... from a pinned shortcut
function handleLaunchAction() {
  let action;
  try { action = new URLSearchParams(location.search).get('action'); } catch(e) {}
  if (!action) return;
  try { history.replaceState({}, '', location.pathname); } catch(e) {}
  setTimeout(() => {
    switch (action) {
      case 'add-expense': switchPage('summary'); setSummaryType('expense'); openAddModal(); switchAddTab('expense'); break;
      case 'add-income':  switchPage('summary'); setSummaryType('income');  openAddModal(); switchAddTab('income');  break;
      case 'loans':       switchPage('loans');   break;
      case 'emis':        switchPage('emis');    break;
      case 'reports':     openSettings(); openSubPage('reports'); break;
    }
  }, 350);
}

// ══════════════════════════════════════════════════════════════
// FEEDBACK — bug reports and feature requests
// ══════════════════════════════════════════════════════════════
const SUPPORT_EMAIL = 'you@example.com';   // ← change this to your address

const FB_AREAS = {
  bug:     ['Expenses','Income','Loans','EMIs','Reports','Sync / login','Appearance','Something else'],
  feature: ['Expenses','Income','Loans','EMIs','Reports','Budgets','Notifications','Something else']
};
let fbMode = 'bug';
let fbArea = '';

function openFeedback(mode) {
  fbMode = mode;
  fbArea = '';
  openSubPage('feedback');
  const isBug = mode === 'bug';
  document.getElementById('fb-title').textContent = isBug ? 'Report a bug' : 'Suggest a feature';
  document.getElementById('fb-intro').textContent = isBug
    ? 'Tell me what happened and what you expected instead. The more specific, the faster it gets fixed.'
    : 'Describe what you want to be able to do and why it would help. Rough ideas are welcome.';
  document.getElementById('fb-cat-label').textContent = isBug ? 'Where did it happen?' : 'Which area?';
  document.getElementById('fb-subject').value = '';
  document.getElementById('fb-body').value = '';
  document.getElementById('fb-body').placeholder = isBug
    ? 'What I did:\n\nWhat happened:\n\nWhat I expected:'
    : 'What I want to do:\n\nWhy it would help:';
  renderFbChips();
  renderDiag();
}

function renderFbChips() {
  document.getElementById('fb-chips').innerHTML = FB_AREAS[fbMode]
    .map(a => `<div class="fb-chip ${fbArea === a ? 'active' : ''}" onclick="setFbArea('${esc(a)}')">${esc(a)}</div>`)
    .join('');
}
function setFbArea(a) { fbArea = (fbArea === a ? '' : a); renderFbChips(); }

function diagBlock() {
  const ua = navigator.userAgent;
  const installed = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  const last = getLastSync();
  return [
    `App version : ${APP_VERSION}`,
    `Theme       : ${document.documentElement.getAttribute('data-theme') || 'light'}`,
    `Display     : ${installed ? 'installed app' : 'browser'}`,
    `Accounts    : ${accounts.length}`,
    `Last sync   : ${last ? new Date(last).toLocaleString() : 'never'}`,
    `Online      : ${navigator.onLine ? 'yes' : 'no'}`,
    `Screen      : ${window.innerWidth}x${window.innerHeight}`,
    `Browser     : ${ua}`
  ].join('\n');
}

function renderDiag() {
  const on = document.getElementById('fb-diag').checked;
  const pre = document.getElementById('fb-diag-preview');
  pre.style.display = on ? 'block' : 'none';
  if (on) pre.textContent = diagBlock();
}

function buildFeedback() {
  const subject = (document.getElementById('fb-subject').value || '').trim();
  const body    = (document.getElementById('fb-body').value || '').trim();
  const tag     = fbMode === 'bug' ? 'Bug' : 'Feature';
  const line    = `[${tag}]${fbArea ? ' ' + fbArea + ' —' : ''} ${subject || 'No summary'}`;
  let text = body || '(no details given)';
  if (document.getElementById('fb-diag').checked) {
    text += '\n\n----- device info -----\n' + diagBlock();
  }
  return { subject: line, body: text };
}

function sendFeedback() {
  const subject = (document.getElementById('fb-subject').value || '').trim();
  const body    = (document.getElementById('fb-body').value || '').trim();
  if (!subject && !body) { showToast('Add a summary or some details first'); return; }
  const fb = buildFeedback();
  const url = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(fb.subject)}&body=${encodeURIComponent(fb.body)}`;
  try {
    window.location.href = url;
    showToast('Opening your email app...');
  } catch(e) {
    showToast('Could not open email — copy it instead');
  }
}

async function copyFeedback() {
  const fb = buildFeedback();
  const text = fb.subject + '\n\n' + fb.body;
  try {
    await navigator.clipboard.writeText(text);
    showToast('Copied to clipboard');
  } catch(e) {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); showToast('Copied to clipboard'); }
    catch(err) { showToast('Copy failed'); }
    document.body.removeChild(ta);
  }
}

// ══════════════════════════════════════════════════════════════
// PREFERENCES
// ══════════════════════════════════════════════════════════════
const PREFS_KEY = 'wallet_prefs_v1';
let prefs = { hideBalance: true, decimals: false, haptics: true };

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) prefs = Object.assign(prefs, JSON.parse(raw) || {});
  } catch(e) {}
}
function setPref(key, val) {
  prefs[key] = !!val;
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch(e) {}
  if (key === 'hideBalance') { balanceHidden = !!val; updateEyeIcon(); }
  if (key === 'decimals')    renderAll();
  else if (key === 'hideBalance') renderDashboard();
  if (key === 'haptics' && val) buzz(12);
}
function buzz(ms) {
  if (!prefs.haptics) return;
  try { if (navigator.vibrate) navigator.vibrate(ms); } catch(e) {}
}

// ══════════════════════════════════════════════════════════════
// CATEGORIES PAGE
// ══════════════════════════════════════════════════════════════
let catTab = 'expense';
let _catDirty = false;

const CAT_DEFAULTS = {
  expense: () => DEFAULT_EXPENSE, income: () => DEFAULT_INCOME,
  loan:    () => DEFAULT_LOAN,    emi:    () => DEFAULT_EMI
};

// Everything currently switched on for a type (defaults still checked + customs)
function getConfigList(type) {
  const defaults = CAT_DEFAULTS[type]();
  const st = configState[type];
  return [...defaults.filter(c => st.checked.has(c)), ...st.custom];
}

function setCatTab(tab) {
  catTab = tab;
  syncCatSegments();
  renderCatList();
  const inp = document.getElementById('cat-add-input');
  if (inp) { inp.value = ''; inp.placeholder = `New ${tab} category`; }
}

function syncCatSegments() {
  const order = ['expense','income','loan','emi'];
  document.querySelectorAll('#cat-segmented .segment').forEach((el,i) =>
    el.classList.toggle('active', order[i] === catTab));
}

function renderCatList() {
  const el = document.getElementById('cat-list');
  if (!el) return;
  const defaults = CAT_DEFAULTS[catTab]();
  const st = configState[catTab];
  let html = '';

  defaults.forEach(cat => {
    const on = st.checked.has(cat);
    html += `<div class="cat-row">
      <div class="cat-dot" style="background:${catColor(cat)}">${esc(cat.charAt(0).toUpperCase())}</div>
      <div class="cat-name">${esc(cat)}</div>
      <label class="toggle"><input type="checkbox" ${on ? 'checked' : ''}
        onchange="toggleCat('${esc(cat).replace(/'/g,"\\'")}',this.checked)"><span class="toggle-slider"></span></label>
    </div>`;
  });

  st.custom.forEach(cat => {
    html += `<div class="cat-row">
      <div class="cat-dot" style="background:${catColor(cat)}">${esc(cat.charAt(0).toUpperCase())}</div>
      <div class="cat-name">${esc(cat)}<span class="cat-badge">Custom</span></div>
      <button class="cat-del" onclick="removeCustomCat('${esc(cat).replace(/'/g,"\\'")}')" title="Delete">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
      </button>
    </div>`;
  });

  if (!html) html = '<div style="text-align:center;color:var(--text3);padding:26px;font-size:13px">Nothing here yet</div>';
  el.innerHTML = html;
}

// Deterministic colour per category name so the dots stay stable across reloads
function catColor(name) {
  const palette = ['#1a73e8','#8b5cf6','#10b981','#f43f5e','#f59e0b','#06b6d4','#ec4899','#84cc16','#6366f1','#f97316'];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

function toggleCat(cat, on) {
  if (on) configState[catTab].checked.add(cat);
  else    configState[catTab].checked.delete(cat);
  markCatDirty();
}

function addCatFromPage() {
  const inp = document.getElementById('cat-add-input');
  const val = (inp.value || '').trim();
  if (!val) { showToast('Enter a category name'); return; }
  const exists = CAT_DEFAULTS[catTab]().includes(val) || configState[catTab].custom.includes(val);
  if (exists) { showToast('That category already exists'); return; }
  configState[catTab].custom.push(val);
  inp.value = '';
  renderCatList();
  markCatDirty();
}

function removeCustomCat(cat) {
  showConfirm(`Remove the custom category "${cat}"?\n\nEntries already using it keep their category.`, () => {
    configState[catTab].custom = configState[catTab].custom.filter(c => c !== cat);
    renderCatList();
    markCatDirty();
  }, 'Remove');
}

function markCatDirty() {
  _catDirty = true;
  document.getElementById('cat-savebar').classList.add('show');
}
function markCatClean() {
  _catDirty = false;
  document.getElementById('cat-savebar').classList.remove('show');
}

function openConfig() { openSubPage('categories'); }

function openReport() { openSubPage('reports'); }

// ── ADD MODAL TABS ──
function switchAddTab(tab) {
  currentAddTab = tab;
  document.querySelectorAll('#add-tabs .sheet-tab').forEach((t, i) => {
    t.classList.toggle('active', ['expense', 'income', 'loan'][i] === tab);
  });
  document.getElementById('add-expense').style.display = tab === 'expense' ? 'block' : 'none';
  document.getElementById('add-income').style.display  = tab === 'income'  ? 'block' : 'none';
  document.getElementById('add-loan').style.display    = tab === 'loan'    ? 'block' : 'none';
}

// ── LOAN ACTION SHEET TABS ──
function switchLaTab(tab) {
  document.querySelectorAll('#la-tabs .sheet-tab').forEach((t, i) =>
    t.classList.toggle('active', ['repay', 'history', 'edit'][i] === tab));
  document.getElementById('la-repay').style.display  = tab === 'repay'   ? 'block' : 'none';
  document.getElementById('la-history').style.display = tab === 'history' ? 'block' : 'none';
  document.getElementById('la-edit').style.display = tab === 'edit' ? 'block' : 'none';
  if (tab === 'history') renderLoanHistory();
  if (tab === 'edit') renderLoanEditForm();
}

function getLoanOriginRow(loanId) {
  return (appData.loans || []).find(r =>
    String(r['Loan ID'] || '').trim() === loanId &&
    (r['Category'] === 'Lent' || r['Category'] === 'Borrowed'));
}

function sheetDateToISO(dateRaw) {
  if (!dateRaw) return todayISO();
  const ts = parseSheetDate(dateRaw);
  if (!ts) return todayISO();
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function renderLoanEditForm() {
  const l = currentLoanAction;
  if (!l) return;
  const origin = getLoanOriginRow(l.loanId);
  document.getElementById('le-date').value = sheetDateToISO(origin && origin['Date']);
  document.getElementById('le-amount').value = l.total || '';
  document.getElementById('le-desc').value = l.person || '';
  document.getElementById('le-pm').value = (origin && origin['Payment Mode']) || 'UPI';
  const rmk = origin && origin['Remarks'];
  document.getElementById('le-remarks').value = (rmk && rmk !== '-') ? rmk : '';
}

async function saveLoanEdit() {
  const l = currentLoanAction;
  if (!l) return;
  const date = document.getElementById('le-date').value;
  const amount = document.getElementById('le-amount').value;
  const desc = document.getElementById('le-desc').value.trim();
  const pm = document.getElementById('le-pm').value;
  const remarks = document.getElementById('le-remarks').value || '-';
  if (!date || !amount || !desc) { showToast('Fill required fields'); return; }
  const btn = document.getElementById('le-save-btn');
  btn.disabled = true; btn.textContent = 'Saving...';
  try {
    const res = await api({
      action: 'editLoan', userId: currentUser.id, loanId: l.loanId,
      date: fmtDateForSheet(date), amount, description: desc, paymentMode: pm, remarks
    });
    if (res.success) {
      showToast('Loan updated');
      closeOverlay('loan-action-overlay');
      clearCache();
      await loadAllData();
    } else { showToast('Error: ' + (res.error || 'Failed')); }
  } catch(e) { showToast('Connection error'); }
  btn.disabled = false; btn.textContent = 'Save Changes';
}

// ── EMPTY STATE ──
function emptyState(title, sub) {
  return `<div style="text-align:center;padding:40px 20px;color:var(--text3)">
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" style="margin-bottom:12px;opacity:.4"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
    <div style="font-size:15px;font-weight:700;color:var(--text2);margin-bottom:4px">${title}</div>
    <div style="font-size:13px">${sub}</div>
  </div>`;
}

// ── FILL SELECT ──
function fillSelect(id, options) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = options.map(o => `<option>${o}</option>`).join('');
}

// ── ACTIVE CATEGORIES ──
function getActiveCategories(type) {
  const defaults = type === 'expense' ? DEFAULT_EXPENSE : type === 'income' ? DEFAULT_INCOME : DEFAULT_LOAN;
  const state = configState[type];

  const serverCfg = appData.config || {};

  // Config values may be arrays (from API) or comma strings (legacy) — handle both
  const toArr = (val) => {
    if (!val) return [];
    if (Array.isArray(val)) return val.filter(Boolean);
    return String(val).split(',').map(s => s.trim()).filter(Boolean);
  };

  const serverCustom    = toArr(serverCfg[type + 'Custom']);
  const serverUnchecked = toArr(serverCfg[type + 'Unchecked']);

  const active = defaults.filter(c => !serverUnchecked.includes(c));
  const custom = [...new Set([...state.custom, ...serverCustom])];
  return [...active, ...custom];
}

// ── POPULATE ALL CATEGORY SELECTS ──
function populateCategorySelects() {
  fillSelect('exp-cat', getActiveCategories('expense'));
  fillSelect('inc-cat', getActiveCategories('income'));
  fillSelect('loan-type', ['Lent (I gave money)', 'Borrowed (I took money)'].map ? ['Lent', 'Borrowed'] : ['Lent', 'Borrowed']);
  populateEMICatSelect();
}

// ── DASHBOARD FILTER ──
function setDashFilter(el) {
  document.querySelectorAll('.dash-chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  dashFilterType = el.dataset.type;
  const rangeRow = document.getElementById('dash-range-row');
  if (rangeRow) rangeRow.style.display = dashFilterType === 'range' ? 'flex' : 'none';
  if (dashFilterType !== 'range') renderDashboard();
}

function applyDashRange() {
  dashFilterRange.from = document.getElementById('dash-from').value;
  dashFilterRange.to   = document.getElementById('dash-to').value;
  if (!dashFilterRange.from || !dashFilterRange.to) { showToast('Select both dates'); return; }
  renderDashboard();
}

// ── MONTH FILTER CHIPS ──
// The Summary page rebuilds its own chips on every render, so this just
// refreshes whichever type is currently showing.
function buildMonthChips() { renderSummary(); }

function buildDashMonthChips() {
  // Dashboard uses its own dash-chip elements already in HTML — nothing extra needed
}


// ── RENDER ALL ──
function renderAll() {
  renderDashboard();
  renderSummary();
  renderAnalytics();
  renderLoans();
  renderEMIs();
  const plOverlay = document.getElementById('person-loans-overlay');
  if (plOverlay && plOverlay.classList.contains('open')) renderPersonLoans();
}

// ── RENDER DASHBOARD ──
function renderDashboard() {
  const range = getDateRange(dashFilterType);
  const from = range.from, to = range.to;

  const expenses = appData.expenses.filter(r => { const ts = parseSheetDate(r['Date']); return ts >= from && ts <= to; });
  const income   = appData.income.filter(r   => { const ts = parseSheetDate(r['Date']); return ts >= from && ts <= to; });

  const totalExp = expenses.reduce((s, r) => s + Number(r['Expense Amount'] || 0), 0);
  const totalInc = income.reduce((s, r)   => s + Number(r['Income Amount']   || 0), 0);
  const balance  = totalInc - totalExp;

  // Loans summary
  const loanSummary = appData.loanSummary || [];
  const toReceive = loanSummary.filter(l => l.type === 'Lent' || l.type === 'lent').reduce((s, l) => s + Number(l.pending || 0), 0);
  const toOwe     = loanSummary.filter(l => l.type === 'Borrowed' || l.type === 'borrowed').reduce((s, l) => s + Number(l.pending || 0), 0);

  // Period label
  const labelMap = { today: 'Today', week: 'This Week', month: 'This Month', range: 'Custom Range' };
  const periodLabel = labelMap[dashFilterType] || 'This Month';
  const el = document.getElementById('dash-period-label');
  if (el) el.textContent = periodLabel;

  document.getElementById('dash-balance').innerHTML = fmtBalance(balance);
  document.getElementById('dash-income').textContent  = fmtMini(totalInc);
  document.getElementById('dash-expense').textContent = fmtMini(totalExp);
  document.getElementById('dash-receive').textContent = fmt(toReceive);
  document.getElementById('dash-owe').textContent     = fmt(toOwe);

  // Recent transactions — merge expenses + income, sort newest first, take 10
  const allTxns = [
    ...expenses.map((r, i) => ({ ...r, _type: 'expense', _amt: Number(r['Expense Amount'] || 0), _date: r['Date'], _cat: r['Category'], _desc: r['Description'], _pm: r['Payment Mode'], _rowIndex: r._rowIndex, _sortKey: sortKey(r, i) })),
    ...income.map((r, i)   => ({ ...r, _type: 'income',  _amt: Number(r['Income Amount']   || 0), _date: r['Date'], _cat: r['Category'], _desc: r['Description'], _pm: r['Payment Mode'], _rowIndex: r._rowIndex, _sortKey: sortKey(r, i) }))
  ].sort((a, b) => b._sortKey - a._sortKey).slice(0, 10);

  const recentEl = document.getElementById('dash-recent');
  if (!allTxns.length) {
    recentEl.innerHTML = emptyState('No transactions', 'Add your first entry using the + button');
    return;
  }
  recentEl.innerHTML = allTxns.map(r => entryItemHTML(r)).join('');
}

// ── ENTRY ITEM HTML ──
function entryItemHTML(r) {
  const isInc  = r._type === 'income';
  const color  = isInc ? 'var(--green)' : 'var(--red)';
  const bgClr  = isInc ? 'rgba(52,168,83,.12)' : 'rgba(234,67,53,.12)';
  const sign   = isInc ? '+' : '-';
  const icon   = isInc
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2"><polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/></svg>`;

  const key = (r._type || 'exp') + '_' + (r._rowIndex || Math.random());
  _entryRegistry[key] = r;

  return `<div class="entry-item" onclick="openEntryDetail('${key}')">
    <div class="entry-icon" style="background:${bgClr}">${icon}</div>
    <div style="flex:1;min-width:0">
      <div class="entry-cat">${r._cat || ''}</div>
      <div class="entry-desc">${r._desc || ''}</div>
      <div class="entry-date">${fmtDisplay(r._date)} · ${r._pm || ''}</div>
    </div>
    <div class="entry-right">
      <div class="entry-amount" style="color:${color}">${sign}${fmt(r._amt)}</div>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════════════
// SUMMARY — donut, month picker, type / period / category filters
// ══════════════════════════════════════════════════════════════
let summaryType   = 'expense';
let summaryPeriod = 'monthly';
let summaryAnchor = { y: new Date().getFullYear(), m: new Date().getMonth() };
let summaryCats   = null;                    // null = all categories
let summaryCustom = { from: null, to: null };
let _pendingCats  = null;                    // working copy while the sheet is open
let summarySel    = null;                    // highlighted category, null = show all
const MAX_SLICES  = 7;                       // beyond this the tail collapses into "Other"

const PERIOD_OPTS = [
  { id:'monthly',   label:'Monthly',        note:'Default' },
  { id:'weekly',    label:'Weekly' },
  { id:'quarterly', label:'Quarterly' },
  { id:'ytd',       label:'Year to date' },
  { id:'last6',     label:'Last 6 months' },
  { id:'last12',    label:'Last 12 months' },
  { id:'all',       label:'All time' },
  { id:'custom',    label:'Custom' }
];
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ── Date range for whatever the current period + anchor month is ──
function getSummaryRange() {
  const { y, m } = summaryAnchor;
  const now = new Date();
  let from, to;
  switch (summaryPeriod) {
    case 'weekly': {
      const day = (now.getDay() + 6) % 7;           // Monday-first
      from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day);
      to   = new Date(from); to.setDate(from.getDate() + 6); to.setHours(23,59,59,999);
      break;
    }
    case 'quarterly': {
      const q = Math.floor(m / 3);
      from = new Date(y, q * 3, 1);
      to   = new Date(y, q * 3 + 3, 0, 23,59,59,999);
      break;
    }
    case 'ytd':
      from = new Date(y, 0, 1);
      to   = (y === now.getFullYear()) ? now : new Date(y, 11, 31, 23,59,59,999);
      break;
    case 'last6':
      from = new Date(y, m - 5, 1);
      to   = new Date(y, m + 1, 0, 23,59,59,999);
      break;
    case 'last12':
      from = new Date(y, m - 11, 1);
      to   = new Date(y, m + 1, 0, 23,59,59,999);
      break;
    case 'all':
      return { from: 0, to: Date.now() + 31536000000 };
    case 'custom': {
      if (!summaryCustom.from || !summaryCustom.to) { summaryPeriod = 'monthly'; return getSummaryRange(); }
      const [fy,fm,fd] = summaryCustom.from.split('-');
      const [ty,tm,td] = summaryCustom.to.split('-');
      from = new Date(+fy, +fm-1, +fd);
      to   = new Date(+ty, +tm-1, +td, 23,59,59,999);
      break;
    }
    default:
      from = new Date(y, m, 1);
      to   = new Date(y, m + 1, 0, 23,59,59,999);
  }
  return { from: from.getTime(), to: to.getTime() };
}

function summaryPeriodLabel() {
  const { y, m } = summaryAnchor;
  const now = new Date();
  switch (summaryPeriod) {
    case 'weekly':    return 'This week';
    case 'quarterly': return `Q${Math.floor(m/3)+1} ${y}`;
    case 'ytd':       return `${y} to date`;
    case 'last6':     return 'Last 6 months';
    case 'last12':    return 'Last 12 months';
    case 'all':       return 'All time';
    case 'custom':    return 'Custom range';
    default:
      return (y === now.getFullYear() && m === now.getMonth())
        ? 'This month' : `${MONTH_NAMES[m]} ${y}`;
  }
}

// ── Data ──
function summaryRows() {
  const isExp  = summaryType === 'expense';
  const src    = isExp ? appData.expenses : appData.income;
  const amtKey = isExp ? 'Expense Amount' : 'Income Amount';
  const { from, to } = getSummaryRange();
  return src
    .map((r, i) => ({ ...r, _type: isExp ? 'expense' : 'income', _amt: Number(r[amtKey] || 0),
      _date: r['Date'], _cat: r['Category'] || 'Uncategorised', _desc: r['Description'],
      _pm: r['Payment Mode'], _rowIndex: r._rowIndex, _sortKey: sortKey(r, i) }))
    .filter(r => {
      const ts = parseSheetDate(r._date);
      if (ts < from || ts > to) return false;
      if (summaryCats && !summaryCats.has(r._cat)) return false;
      return true;
    })
    .sort((a, b) => b._sortKey - a._sortKey);
}

function renderSummary() {
  const isExp = summaryType === 'expense';
  const rows  = summaryRows();
  const total = rows.reduce((s, r) => s + r._amt, 0);

  const map = new Map();
  rows.forEach(r => {
    const g = map.get(r._cat) || { cat: r._cat, amt: 0, count: 0 };
    g.amt += r._amt; g.count++;
    map.set(r._cat, g);
  });
  const groups = [...map.values()].sort((a, b) => b.amt - a.amt);

  // Keep the selection valid if the data changed underneath it
  if (summarySel && !groups.some(g => g.cat === summarySel)) summarySel = null;

  const selected = summarySel ? groups.find(g => g.cat === summarySel) : null;
  document.getElementById('summary-total').textContent  = fmt(selected ? selected.amt : total);
  document.getElementById('summary-count').textContent  = selected
    ? selected.count + (selected.count === 1 ? ' entry' : ' entries')
    : rows.length + (rows.length === 1 ? ' entry' : ' entries');

  const periodEl = document.getElementById('summary-period');
  periodEl.textContent = selected ? selected.cat : summaryPeriodLabel();
  document.getElementById('summary-period-btn').classList.toggle('is-cat', !!selected);

  document.getElementById('chip-type').textContent   = isExp ? 'Expenses' : 'Income';
  document.getElementById('chip-period').textContent = PERIOD_OPTS.find(p => p.id === summaryPeriod).label;
  document.getElementById('chip-cats').textContent   =
    !summaryCats ? 'All categories'
    : summaryCats.size === 1 ? [...summaryCats][0]
    : `${summaryCats.size} categories`;

  drawDonut(groups, total);

  const el = document.getElementById('summary-breakdown');
  if (!groups.length) {
    el.innerHTML = emptyState(isExp ? 'No expenses' : 'No income', 'Nothing recorded for this period');
    return;
  }
  el.innerHTML = groups.map((g, i) => {
    const pctRaw = total > 0 ? (g.amt / total * 100) : 0;
    const pct = pctRaw >= 10 ? pctRaw.toFixed(1) : pctRaw.toFixed(2);
    const on  = summarySel === g.cat;
    return `<div class="sum-row ${on ? 'sel' : ''} ${summarySel && !on ? 'dim' : ''}"
        style="animation-delay:${Math.min(i,8) * 35}ms"
        onclick="tapCategory('${esc(g.cat).replace(/'/g,"\\'")}')">
      <div class="sum-icon" style="border-color:${catColor(g.cat)};color:${catColor(g.cat)}">
        ${esc(g.cat.charAt(0).toUpperCase())}
      </div>
      <div class="sum-name">${esc(g.cat)}<span class="sum-count">${g.count}</span></div>
      <div class="sum-amt">${fmt(g.amt)}</div>
      <div class="sum-pct">${pct}%</div>
    </div>`;
  }).join('');
}

// First tap highlights the slice, second tap opens the entries
function tapCategory(cat) {
  if (summarySel === cat) { openCatEntries(cat); return; }
  summarySel = cat;
  buzz(8);
  renderSummary();
}

function clearCategorySel() {
  if (!summarySel) { openDatePicker(); return; }
  summarySel = null;
  renderSummary();
}

// Segmented ring. With lots of categories a plain 1-arc-per-category ring turns
// into unreadable slivers, so the long tail collapses into a single "Other" arc,
// gaps shrink as the count rises, and every arc keeps a minimum visible length.
function drawDonut(groups, total) {
  const svg = document.getElementById('summary-donut');
  if (!svg) return;
  const R = 78, CX = 100, CY = 100, C = 2 * Math.PI * R;

  if (!total || !groups.length) {
    svg.innerHTML = `<circle cx="${CX}" cy="${CY}" r="${R}" fill="none"
      stroke="var(--border)" stroke-width="20"/>`;
    return;
  }

  // Collapse everything past MAX_SLICES into one grey arc
  let slices = groups;
  if (groups.length > MAX_SLICES) {
    const head = groups.slice(0, MAX_SLICES - 1);
    const tail = groups.slice(MAX_SLICES - 1);
    slices = [...head, {
      cat: 'Other', amt: tail.reduce((s, g) => s + g.amt, 0),
      count: tail.reduce((s, g) => s + g.count, 0), _other: true
    }];
  }

  const n    = slices.length;
  const GAP  = n > 1 ? Math.max(3, 10 - n * 0.7) : 0;   // tighter gaps as slices multiply
  const MINL = 5;                                        // never let a slice vanish
  const usable = C - GAP * n;

  // Scale raw shares into the usable arc, then lift any sliver up to MINL
  let lens = slices.map(g => (g.amt / total) * usable);
  const deficit = lens.reduce((s, l) => s + Math.max(0, MINL - l), 0);
  if (deficit > 0) {
    const spare = lens.reduce((s, l) => s + Math.max(0, l - MINL), 0);
    if (spare > 0) {
      lens = lens.map(l => l < MINL ? MINL : l - (l - MINL) * (deficit / spare));
    }
  }

  let offset = 0;
  svg.innerHTML = slices.map((g, i) => {
    const len   = Math.max(0.5, lens[i]);
    const dim   = summarySel && g.cat !== summarySel;
    const color = g._other ? 'var(--text3)' : catColor(g.cat);
    const el = `<circle cx="${CX}" cy="${CY}" r="${R}" fill="none"
      stroke="${color}" stroke-width="${summarySel === g.cat ? 23 : 20}" stroke-linecap="round"
      opacity="${dim ? .2 : 1}"
      stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-offset}"
      transform="rotate(-90 ${CX} ${CY})"
      style="cursor:pointer" onclick="tapCategory('${esc(g.cat).replace(/'/g,"\\'")}')"
      ><title>${esc(g.cat)} · ${fmt(g.amt)}</title></circle>`;
    offset += len + GAP;
    return el;
  }).join('');
}

// ── DATE PICKER ──
function openDatePicker() {
  renderDatePicker();
  document.getElementById('datepick-overlay').classList.add('open');
}

function dataYears() {
  const years = new Set();
  [...appData.expenses, ...appData.income].forEach(r => {
    const ts = parseSheetDate(r['Date']);
    if (ts) years.add(new Date(ts).getFullYear());
  });
  const now = new Date().getFullYear();
  for (let i = 0; i < 5; i++) years.add(now - i);   // always offer the last 5
  years.add(summaryAnchor.y);
  return [...years].sort((a, b) => b - a);
}

function renderDatePicker() {
  const now = new Date();
  document.getElementById('dp-years').innerHTML = dataYears().map(y =>
    `<div class="year-pill ${y === summaryAnchor.y ? 'active' : ''}" onclick="pickYear(${y})">${y}</div>`
  ).join('');

  document.getElementById('dp-months').innerHTML = MONTH_NAMES.map((name, i) => {
    const future = summaryAnchor.y > now.getFullYear() ||
                   (summaryAnchor.y === now.getFullYear() && i > now.getMonth());
    return `<div class="month-cell ${i === summaryAnchor.m ? 'active' : ''} ${future ? 'disabled' : ''}"
      ${future ? '' : `onclick="pickMonth(${i})"`}>${name}</div>`;
  }).join('');
}

function pickYear(y) {
  const now = new Date();
  summaryAnchor.y = y;
  // Don't leave the anchor sitting on a future month after switching years
  if (y === now.getFullYear() && summaryAnchor.m > now.getMonth()) summaryAnchor.m = now.getMonth();
  renderDatePicker();
}

function pickMonth(m) {
  summaryAnchor.m = m;
  // Picking a month only makes sense for month-anchored periods
  if (['weekly','all','custom'].includes(summaryPeriod)) summaryPeriod = 'monthly';
  renderDatePicker();
  renderSummary();
  setTimeout(() => closeOverlay('datepick-overlay'), 160);
}

// ── TYPE SHEET ──
function openTypeSheet() {
  document.getElementById('type-opts').innerHTML = [
    { id:'expense', label:'Expenses', note:'Default' },
    { id:'income',  label:'Income' }
  ].map(o => optRow(o, summaryType === o.id, `setSummaryType('${o.id}')`)).join('');
  document.getElementById('type-overlay').classList.add('open');
}

function optRow(o, active, onclick) {
  return `<div class="opt-row ${active ? 'active' : ''}" onclick="${onclick}">
    <span>${o.label}</span>
    ${o.note ? `<span class="opt-note">${o.note}</span>` : ''}
  </div>`;
}

function setSummaryType(t) {
  summaryType = t;
  summaryCats = null;              // categories differ between types
  summarySel  = null;
  renderSummary();
  closeOverlay('type-overlay');
}

// ── PERIOD SHEET ──
function openPeriodSheet() {
  document.getElementById('period-opts').innerHTML = PERIOD_OPTS
    .map(o => optRow(o, summaryPeriod === o.id, `setSummaryPeriod('${o.id}')`)).join('');
  const cust = document.getElementById('period-custom');
  cust.style.display = summaryPeriod === 'custom' ? 'block' : 'none';
  if (summaryCustom.from) document.getElementById('sum-from').value = summaryCustom.from;
  if (summaryCustom.to)   document.getElementById('sum-to').value   = summaryCustom.to;
  document.getElementById('period-overlay').classList.add('open');
}

function setSummaryPeriod(p) {
  if (p === 'custom') {
    summaryPeriod = 'custom';
    document.getElementById('period-custom').style.display = 'block';
    document.getElementById('period-opts').innerHTML = PERIOD_OPTS
      .map(o => optRow(o, o.id === 'custom', `setSummaryPeriod('${o.id}')`)).join('');
    return;
  }
  summaryPeriod = p;
  renderSummary();
  closeOverlay('period-overlay');
}

function applyCustomPeriod() {
  const f = document.getElementById('sum-from').value;
  const t = document.getElementById('sum-to').value;
  if (!f || !t) { showToast('Pick both dates'); return; }
  if (f > t)    { showToast('From date is after the To date'); return; }
  summaryCustom = { from: f, to: t };
  summaryPeriod = 'custom';
  renderSummary();
  closeOverlay('period-overlay');
}

// ── CATEGORY FILTER SHEET ──
function allSummaryCats() {
  const set = new Set(getActiveCategories(summaryType === 'expense' ? 'expense' : 'income'));
  const src = summaryType === 'expense' ? appData.expenses : appData.income;
  src.forEach(r => set.add(r['Category'] || 'Uncategorised'));   // include retired categories still in use
  return [...set].sort((a, b) => a.localeCompare(b));
}

function openCatFilter() {
  _pendingCats = summaryCats ? new Set(summaryCats) : null;
  renderCatPicker();
  document.getElementById('catfilter-overlay').classList.add('open');
}

function renderCatPicker() {
  const cats = allSummaryCats();
  const allOn = !_pendingCats || _pendingCats.size === 0;
  let html = `<div class="catpick ${allOn ? 'active' : ''}" onclick="toggleCatPick(null)">
      <div class="catpick-tile all">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="7" cy="7" r="2.6"/><circle cx="17" cy="7" r="2.6"/><circle cx="7" cy="17" r="2.6"/><circle cx="17" cy="17" r="2.6"/></svg>
      </div>
      <div class="catpick-label">All</div>
    </div>`;
  html += cats.map(c => {
    const on = _pendingCats && _pendingCats.has(c);
    return `<div class="catpick ${on ? 'active' : ''}" onclick="toggleCatPick('${esc(c).replace(/'/g,"\\'")}')">
      <div class="catpick-tile" style="border-color:${catColor(c)};color:${catColor(c)}">
        ${esc(c.charAt(0).toUpperCase())}
      </div>
      <div class="catpick-label">${esc(c)}</div>
    </div>`;
  }).join('');
  document.getElementById('catpick-grid').innerHTML = html;
}

function toggleCatPick(cat) {
  if (cat === null) { _pendingCats = null; renderCatPicker(); return; }
  if (!_pendingCats) _pendingCats = new Set();
  if (_pendingCats.has(cat)) _pendingCats.delete(cat); else _pendingCats.add(cat);
  if (_pendingCats.size === 0) _pendingCats = null;
  renderCatPicker();
}

function applyCatFilter() {
  summaryCats = (_pendingCats && _pendingCats.size) ? new Set(_pendingCats) : null;
  renderSummary();
  closeOverlay('catfilter-overlay');
}

// Tapping a category opens its entries — this is where individual
// view / edit / delete still lives now that the flat lists are gone.
function openCatEntries(cat) {
  const rows = summaryRows().filter(r => r._cat === cat);
  const total = rows.reduce((s, r) => s + r._amt, 0);
  document.getElementById('cat-entries-title').textContent = cat;
  const totalEl = document.getElementById('cat-entries-total');
  totalEl.textContent = fmt(total);
  totalEl.className = 'cat-entries-total ' + (summaryType === 'expense' ? 'red' : 'green');
  const el = document.getElementById('cat-entries-list');
  el.innerHTML = rows.length
    ? rows.map(r => entryItemHTML(r)).join('')
    : emptyState('Nothing here', 'No entries in this category');
  document.getElementById('cat-entries-overlay').classList.add('open');
}

// ══════════════════════════════════════════════════════════════
// BANK ACCOUNTS
// Transactions store the account by name in an "Account" column.
// A blank value means the entry predates accounts, or wasn't assigned.
// ══════════════════════════════════════════════════════════════
const UNASSIGNED = '__none__';

function accountsList() { return appData.accounts || []; }
function hasAccounts()  { return accountsList().length > 0; }

// Filters a row set down to the account currently selected in Analytics
function accountRows(rows) {
  if (!anaAccount) return rows;
  if (anaAccount === UNASSIGNED) return rows.filter(r => !String(r['Account'] || '').trim());
  return rows.filter(r => String(r['Account'] || '').trim() === anaAccount);
}

// Opening balance + income - expenses, for one account or all of them
function accountBalance(name) {
  const match = r => name == null
    ? true
    : String(r['Account'] || '').trim() === name;
  const inc = appData.income.filter(match).reduce((s,r) => s + Number(r['Income Amount']||0), 0);
  const exp = appData.expenses.filter(match).reduce((s,r) => s + Number(r['Expense Amount']||0), 0);
  const open = name == null
    ? accountsList().reduce((s,a) => s + Number(a.opening||0), 0)
    : Number((accountsList().find(a => a.name === name) || {}).opening || 0);
  return open + inc - exp;
}

function openAnaAccountSheet() {
  const opts = [{ id:'', label:'All accounts', note:'Default' }]
    .concat(accountsList().map(a => ({ id:a.name, label:a.name })))
    .concat([{ id:UNASSIGNED, label:'Unassigned' }]);
  document.getElementById('anaacct-opts').innerHTML = opts
    .map(o => optRow(o, (anaAccount || '') === o.id, `setAnaAccount('${esc(o.id).replace(/'/g,"\\'")}')`))
    .join('');
  document.getElementById('anaacct-overlay').classList.add('open');
}

function setAnaAccount(id) {
  anaAccount = id || null;
  renderAnalytics();
  closeOverlay('anaacct-overlay');
}

// ── SETTINGS SUB-PAGE ──
function renderAccountsPage() {
  const list = accountsList();
  const el = document.getElementById('bank-list');
  if (!list.length) {
    el.innerHTML = `<div style="text-align:center;color:var(--text3);padding:26px;font-size:13px">
      No accounts yet — add one below</div>`;
  } else {
    el.innerHTML = list.map(a => {
      const bal = accountBalance(a.name);
      return `<div class="settings-row" onclick="openEditAccount(${a.rowId})">
        <div class="settings-chip">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
        </div>
        <div class="settings-row-label">${esc(a.name)}
          <span class="settings-row-hint">Opening ${fmt(a.opening)}</span></div>
        <div class="settings-row-value" style="color:${bal < 0 ? 'var(--red)' : 'var(--green)'}">${fmt(bal)}</div>
        <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
      </div>`;
    }).join('');
  }
  const total = document.getElementById('bank-total');
  if (list.length) {
    const t = accountBalance(null);
    total.style.display = 'block';
    total.innerHTML = `<span>Combined balance</span>
      <span style="color:${t < 0 ? 'var(--red)' : 'var(--text)'}">${fmt(t)}</span>`;
  } else {
    total.style.display = 'none';
  }
}

let editingAccount = null;

function openAddAccount() {
  editingAccount = null;
  document.getElementById('bank-sheet-title').textContent = 'Add bank account';
  document.getElementById('bank-name').value = '';
  document.getElementById('bank-opening').value = '';
  document.getElementById('bank-delete-btn').style.display = 'none';
  document.getElementById('bank-overlay').classList.add('open');
}

function openEditAccount(rowId) {
  const a = accountsList().find(x => x.rowId === rowId);
  if (!a) return;
  editingAccount = a;
  document.getElementById('bank-sheet-title').textContent = 'Edit account';
  document.getElementById('bank-name').value = a.name;
  document.getElementById('bank-opening').value = a.opening;
  document.getElementById('bank-delete-btn').style.display = 'flex';
  document.getElementById('bank-overlay').classList.add('open');
}

async function saveAccount() {
  const name = (document.getElementById('bank-name').value || '').trim();
  const opening = document.getElementById('bank-opening').value;
  if (!name) { showToast('Enter an account name'); return; }
  const btn = document.getElementById('bank-save-btn');
  btn.textContent = 'Saving...'; btn.disabled = true;
  try {
    const res = editingAccount
      ? await api('editAccount', { rowId: editingAccount.rowId, name, opening: opening || 0 })
      : await api('addAccount',  { name, opening: opening || 0 });
    if (res.success) {
      showToast(editingAccount ? 'Account updated' : 'Account added');
      closeOverlay('bank-overlay');
      clearCache();
      await refreshFromAPI();
      renderAccountsPage();
      populateAccountSelects();
    } else { showToast(res.error || 'Failed'); }
  } catch(e) { showToast('Connection error'); }
  btn.textContent = 'Save'; btn.disabled = false;
}

function deleteAccountConfirm() {
  if (!editingAccount) return;
  const a = editingAccount;
  showConfirm(
    `Delete "${a.name}"?\n\nTransactions are kept — they just become unassigned.`,
    async () => {
      const res = await api('deleteAccount', { rowId: a.rowId });
      if (res.success) {
        showToast('Account deleted');
        closeOverlay('bank-overlay');
        clearCache();
        await refreshFromAPI();
        renderAccountsPage();
        populateAccountSelects();
      } else { showToast(res.error || 'Failed'); }
    }, 'Delete');
}

// Fills the account dropdowns on the add / edit entry forms
function populateAccountSelects() {
  const list = accountsList();
  ['add-exp-account','add-inc-account','edit-account'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '<option value="">— No account —</option>' +
      list.map(a => `<option value="${esc(a.name)}">${esc(a.name)}</option>`).join('');
    if (prev) sel.value = prev;
  });
  // Hide the field entirely until at least one account exists
  document.querySelectorAll('.account-field').forEach(el => {
    el.style.display = list.length ? 'block' : 'none';
  });
  const chip = document.getElementById('chip-ana-account');
  if (chip) chip.parentElement.style.display = list.length ? 'flex' : 'none';
}

// ══════════════════════════════════════════════════════════════
// ANALYTICS — bucketed bars, net chart, calendar
// ══════════════════════════════════════════════════════════════
const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const ANA_PERIODS = [
  { id:'weekly',    label:'Weekly' },
  { id:'monthly',   label:'Monthly', note:'Default' },
  { id:'quarterly', label:'Quarterly' },
  { id:'yearly',    label:'Yearly' }
];
const BUCKET_COUNT = 6;

let anaPeriod   = 'monthly';
let netUnit     = 'cur';              // 'cur' | 'pct'
let anaCalDay   = null;               // selected calendar day
let calRef      = null;               // {y,m} month the calendar is showing
let anaAccount  = null;               // null = all accounts

// Each card scrolls and selects on its own — swiping one never moves the others.
const anaView = {
  flow: { offset: 0, selected: BUCKET_COUNT - 1 },   // income vs expenses
  net:  { offset: 0, selected: BUCKET_COUNT - 1 }    // income left
};

function openAnaPeriodSheet() {
  document.getElementById('anaperiod-opts').innerHTML = ANA_PERIODS
    .map(o => optRow(o, anaPeriod === o.id, `setAnaPeriod('${o.id}')`)).join('');
  document.getElementById('anaperiod-overlay').classList.add('open');
}

function setAnaPeriod(p) {
  anaPeriod = p;
  anaView.flow = { offset: 0, selected: BUCKET_COUNT - 1 };
  anaView.net  = { offset: 0, selected: BUCKET_COUNT - 1 };
  anaCalDay = null;
  calRef    = null;
  document.getElementById('chip-ana-period').textContent =
    ANA_PERIODS.find(x => x.id === p).label;
  renderAnalytics();
  closeOverlay('anaperiod-overlay');
}

function setNetUnit(u) {
  netUnit = u;
  document.getElementById('unit-cur').classList.toggle('active', u === 'cur');
  document.getElementById('unit-pct').classList.toggle('active', u === 'pct');
  renderAnalytics();
}

function selectBucket(which, i) {
  anaView[which].selected = i;
  renderAnalytics();
}

// ── SWIPING ──
// Swipe right on either chart to walk backwards through time, left to come
// forward. The calendar swipes month by month independently.
function shiftAnaWindow(which, dir) {   // dir: +1 = older, -1 = newer
  const v = anaView[which];
  const next = v.offset + dir;
  if (next < 0) { showToast('Already at the latest period'); return; }
  v.offset = next;
  renderAnalytics();
  slideHint(which === 'flow' ? 'ana-plot' : 'ana-net-plot', dir);
  buzz(8);
}

function shiftCalendar(dir) {           // dir: +1 = previous month, -1 = next
  const base = calRef || calRefFromBucket(null);
  const d = new Date(base.y, base.m - dir, 1);
  const now = new Date();
  if (d.getFullYear() > now.getFullYear() ||
     (d.getFullYear() === now.getFullYear() && d.getMonth() > now.getMonth())) {
    showToast('That month has not happened yet');
    return;
  }
  calRef = { y: d.getFullYear(), m: d.getMonth() };
  anaCalDay = null;
  renderCalendar();
  slideHint('ana-calendar', dir);
  buzz(8);
}

function calRefFromBucket(b) {
  const d = new Date(b ? b.to : Date.now());
  return { y: d.getFullYear(), m: d.getMonth() };
}

function slideHint(id, dir) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('slide-l', 'slide-r');
  void el.offsetWidth;                  // restart the animation
  el.classList.add(dir > 0 ? 'slide-r' : 'slide-l');
}

// Generic horizontal swipe detector that ignores vertical scrolling
function attachSwipe(id, onSwipe) {
  const el = document.getElementById(id);
  if (!el) return;
  let sx = 0, sy = 0, tracking = false;
  el.addEventListener('pointerdown', e => { sx = e.clientX; sy = e.clientY; tracking = true; }, { passive: true });
  el.addEventListener('pointercancel', () => { tracking = false; });
  el.addEventListener('pointerup', e => {
    if (!tracking) return;
    tracking = false;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
    onSwipe(dx > 0 ? 1 : -1);           // drag right = go back in time
  });
}

function initAnaSwipes() {
  attachSwipe('ana-plot',     d => shiftAnaWindow('flow', d));
  attachSwipe('ana-net-plot', d => shiftAnaWindow('net',  d));
  attachSwipe('ana-calendar', d => shiftCalendar(d));
}

// Builds the last N buckets for whichever granularity is active
function anaBuckets(offset = 0) {
  const now = new Date();
  const out = [];
  for (let k = BUCKET_COUNT - 1; k >= 0; k--) {
    const i = k + offset;               // how many periods back this bucket sits
    let from, to, label, sub = '';
    if (anaPeriod === 'weekly') {
      const day = (now.getDay() + 6) % 7;
      const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day - i * 7);
      from = monday;
      to   = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6, 23,59,59,999);
      label = `${from.getDate()} ${MONTH_ABBR[from.getMonth()]}`;
    } else if (anaPeriod === 'quarterly') {
      const qTotal = Math.floor(now.getMonth() / 3) + now.getFullYear() * 4 - i;
      const qy = Math.floor(qTotal / 4), qi = qTotal % 4;
      from = new Date(qy, qi * 3, 1);
      to   = new Date(qy, qi * 3 + 3, 0, 23,59,59,999);
      label = `Q${qi + 1}`;
      sub = `'${String(qy).slice(2)}`;
    } else if (anaPeriod === 'yearly') {
      const y = now.getFullYear() - i;
      from = new Date(y, 0, 1);
      to   = new Date(y, 11, 31, 23,59,59,999);
      label = String(y);
    } else {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      from = d;
      to   = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23,59,59,999);
      label = MONTH_ABBR[d.getMonth()];
      sub = `'${String(d.getFullYear()).slice(2)}`;
    }
    out.push({ from: from.getTime(), to: to.getTime(), label, sub, date: from, income: 0, expense: 0 });
  }
  const add = (rows, key, field) => rows.forEach(r => {
    const ts = parseSheetDate(r['Date']);
    const b = out.find(x => ts >= x.from && ts <= x.to);
    if (b) b[key] += Number(r[field] || 0);
  });
  add(accountRows(appData.income),   'income',  'Income Amount');
  add(accountRows(appData.expenses), 'expense', 'Expense Amount');

  // Only show the year suffix when the range actually crosses a year
  const years = new Set(out.map(b => b.date.getFullYear()));
  if (years.size < 2) out.forEach(b => b.sub = '');
  return out;
}

function renderAnalytics() {
  // ── Card 1: income vs expenses ──
  const fBuckets = anaBuckets(anaView.flow.offset);
  const fSel = fBuckets[anaView.flow.selected] || fBuckets[fBuckets.length - 1];
  document.getElementById('ana-inc-total').textContent = fmt(fSel.income);
  document.getElementById('ana-exp-total').textContent = fmt(fSel.expense);
  const fMax = Math.max(...fBuckets.map(b => Math.max(b.income, b.expense)), 0);
  document.getElementById('ana-plot').innerHTML = plotHTML('flow', fBuckets, fMax, b => [
    { cls:'green', v:b.income },
    { cls:'blue',  v:b.expense }
  ]);

  // ── Card 2: income left ──
  const nBuckets = anaBuckets(anaView.net.offset);
  const nSel = nBuckets[anaView.net.selected] || nBuckets[nBuckets.length - 1];
  const net = nSel.income - nSel.expense;
  const netPct = nSel.income > 0 ? Math.round(net / nSel.income * 100) : 0;
  const netEl = document.getElementById('ana-net');
  netEl.textContent = netUnit === 'pct'
    ? netPct + '%'
    : (net < 0 ? '-' : '') + fmt(Math.abs(net));
  netEl.className = 'ana-big ' + (net < 0 ? 'red' : net > 0 ? 'green' : '');
  document.getElementById('ana-net-label').textContent = nSel.label +
    (nSel.sub ? ' ' + nSel.sub : '');

  const netVals = nBuckets.map(b =>
    netUnit === 'pct'
      ? (b.income > 0 ? (b.income - b.expense) / b.income * 100 : 0)
      : b.income - b.expense);
  const netMax = Math.max(...netVals.map(Math.abs), 0);
  document.getElementById('ana-net-plot').innerHTML =
    plotHTML('net', nBuckets, netMax,
      (b, i) => [{ cls: netVals[i] < 0 ? 'red' : 'purple', v: Math.abs(netVals[i]) }],
      netUnit === 'pct' ? v => Math.round(v) + '%' : null);

  // ── Card 3: calendar (independent month pointer) ──
  renderCalendar();

  document.getElementById('chip-ana-account').textContent = anaAccount || 'All accounts';
}

// One chart renderer for both plots — bars, right-hand axis, tappable labels
function plotHTML(which, buckets, max, barsFor, fmtAxis) {
  const axis = fmtAxis || (v => shortAmt(v));
  const selIdx = anaView[which].selected;
  const cols = buckets.map((b, i) => {
    const bars = barsFor(b, i).map(bar => {
      const pct = max > 0 ? (bar.v / max) * 100 : 0;
      const h = bar.v > 0 ? Math.max(3, pct) : 3;   // zero still shows a stub
      return `<div class="pbar ${bar.cls} ${bar.v > 0 ? '' : 'zero'}" style="height:${h}%"></div>`;
    }).join('');
    return `<div class="pcol ${i === selIdx ? 'active' : ''}" onclick="selectBucket('${which}',${i})">
      <div class="pcol-bars">${bars}</div>
      <div class="pcol-label">${b.label}${b.sub ? `<span class="pcol-sub">${b.sub}</span>` : ''}</div>
    </div>`;
  }).join('');

  return `<div class="plot-body">
      <div class="plot-cols">${cols}</div>
      <div class="plot-axis">
        <span>${axis(max)}</span>
        <span>${axis(max / 2)}</span>
        <span>${axis(0)}</span>
      </div>
    </div>`;
}

function renderCalendar(bucket) {
  // Calendar always shows a single month. It follows the selected bucket unless
  // the user has swiped it somewhere else.
  if (bucket && !calRef) calRef = calRefFromBucket(bucket);
  if (!calRef) calRef = calRefFromBucket(null);
  const year = calRef.y, month = calRef.m;
  const first = new Date(year, month, 1);
  const days  = new Date(year, month + 1, 0).getDate();
  const lead  = (first.getDay() + 6) % 7;
  const today = new Date();

  document.getElementById('ana-cal-month').textContent = `${MONTH_ABBR[month]} ${year}`;

  const byDay = {};
  accountRows(appData.expenses).forEach(r => {
    const ts = parseSheetDate(r['Date']);
    if (!ts) return;
    const d = new Date(ts);
    if (d.getFullYear() === year && d.getMonth() === month)
      byDay[d.getDate()] = (byDay[d.getDate()] || 0) + Number(r['Expense Amount'] || 0);
  });

  let html = '';
  for (let i = 0; i < lead; i++) html += '<div class="cal-cell empty"></div>';
  for (let d = 1; d <= days; d++) {
    const amt = byDay[d] || 0;
    const isToday = d === today.getDate() && month === today.getMonth() && year === today.getFullYear();
    const isSel = anaCalDay === d;
    html += `<div class="cal-cell ${amt > 0 ? 'has' : ''} ${isSel ? 'sel' : ''} ${isToday ? 'today' : ''}"
        onclick="openDay(${year},${month},${d})">
      <div class="cal-day">${d}</div>
      <div class="cal-amt">${amt > 0 ? shortAmt(amt) : '0'}</div>
    </div>`;
  }
  document.getElementById('ana-calendar').innerHTML = html;
}

// Tapping a day shows everything recorded that day
function openDay(year, month, day) {
  anaCalDay = day;
  const target = new Date(year, month, day);
  const from = target.getTime();
  const to   = new Date(year, month, day, 23,59,59,999).getTime();

  const rows = [
    ...accountRows(appData.expenses).map((r, i) => ({ ...r, _type:'expense', _amt:Number(r['Expense Amount']||0),
      _date:r['Date'], _cat:r['Category'], _desc:r['Description'], _pm:r['Payment Mode'],
      _rowIndex:r._rowIndex, _sortKey:sortKey(r, i) })),
    ...accountRows(appData.income).map((r, i) => ({ ...r, _type:'income', _amt:Number(r['Income Amount']||0),
      _date:r['Date'], _cat:r['Category'], _desc:r['Description'], _pm:r['Payment Mode'],
      _rowIndex:r._rowIndex, _sortKey:sortKey(r, i) }))
  ].filter(r => { const ts = parseSheetDate(r._date); return ts >= from && ts <= to; })
   .sort((a, b) => b._sortKey - a._sortKey);

  const net = rows.reduce((s, r) => s + (r._type === 'income' ? r._amt : -r._amt), 0);
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  document.getElementById('day-title').textContent =
    `${days[target.getDay()]}, ${day} ${MONTH_ABBR[month]}`;
  const totalEl = document.getElementById('day-total');
  totalEl.textContent = (net < 0 ? '-' : net > 0 ? '+' : '') + fmt(Math.abs(net));
  totalEl.className = net < 0 ? 'red' : net > 0 ? 'green' : '';
  document.getElementById('day-list').innerHTML = rows.length
    ? rows.map(r => entryItemHTML(r)).join('')
    : emptyState('Nothing that day', 'No income or expenses recorded');
  document.getElementById('day-overlay').classList.add('open');
  renderCalendar();
}

// Compact amounts so axis labels and calendar cells stay readable
function shortAmt(n) {
  const v = Math.abs(Number(n) || 0);
  if (v >= 10000000) return (v / 10000000).toFixed(1).replace(/\.0$/,'') + 'Cr';
  if (v >= 100000)   return (v / 100000).toFixed(1).replace(/\.0$/,'') + 'L';
  if (v >= 1000)     return (v / 1000).toFixed(1).replace(/\.0$/,'') + 'k';
  return String(Math.round(v));
}

// ── RENDER LOANS (grouped by person) ──
function renderLoans() {
  const summary = appData.loanSummary || [];

  const toReceive = summary.filter(l => l.type === 'Lent' || l.type === 'lent').reduce((s, l) => s + Number(l.pending || 0), 0);
  const toOwe     = summary.filter(l => l.type === 'Borrowed' || l.type === 'borrowed').reduce((s, l) => s + Number(l.pending || 0), 0);

  document.getElementById('loan-receive').textContent = fmt(toReceive);
  document.getElementById('loan-pay').textContent     = fmt(toOwe);

  const el = document.getElementById('loans-list');
  if (!summary.length) { el.innerHTML = emptyState('No loans', 'Add a loan using the + button'); return; }

  const groups  = groupLoansByPerson(summary);
  const active  = groups.filter(g => g.activeCount > 0);
  const settled = groups.filter(g => g.activeCount === 0);

  const toggleRow = settled.length ? `<div class="loan-settled-toggle" onclick="toggleShowSettled()">
      <span>Show settled (${settled.length})</span>
      <label class="toggle" onclick="event.stopPropagation()">
        <input type="checkbox" ${showSettledLoans ? 'checked' : ''} onchange="toggleShowSettled()">
        <span class="toggle-slider"></span>
      </label>
    </div>` : '';

  if (!active.length && !showSettledLoans) {
    el.innerHTML = toggleRow + emptyState('All settled up', 'No active loans right now');
    return;
  }

  let html = active.map(g => personCardHTML(g)).join('');
  if (showSettledLoans && settled.length) {
    html += `<div class="sec-title" style="margin-top:6px">Settled</div>` + settled.map(g => personCardHTML(g)).join('');
  }
  el.innerHTML = toggleRow + html;
}

function toggleShowSettled() {
  showSettledLoans = !showSettledLoans;
  renderLoans();
}

// ── GROUP LOAN SUMMARY ROWS BY PERSON ──
function groupLoansByPerson(summary) {
  const map = {};
  summary.forEach(l => {
    const person = (l.person || 'Unknown').trim() || 'Unknown';
    const key = person.toLowerCase();
    if (!map[key]) map[key] = { person, key, loans: [] };
    map[key].loans.push(l);
  });
  return Object.values(map).map(g => {
    const lentPending     = g.loans.filter(l => (l.type||'').toLowerCase()==='lent').reduce((s,l)=>s+Number(l.pending||0),0);
    const borrowedPending = g.loans.filter(l => (l.type||'').toLowerCase()==='borrowed').reduce((s,l)=>s+Number(l.pending||0),0);
    const activeCount     = g.loans.filter(l => Number(l.pending||0) > 0).length;
    return { ...g, lentPending, borrowedPending, net: lentPending - borrowedPending,
      activeCount, settledCount: g.loans.length - activeCount };
  }).sort((a,b) => Math.abs(b.net) - Math.abs(a.net));
}

// ── PERSON CARD HTML (top-level loans list — one per person) ──
function personCardHTML(g) {
  const isSettled  = g.activeCount === 0;
  const isBalanced = !isSettled && g.net === 0;
  const isReceive  = g.net > 0;
  const color      = isSettled ? 'var(--text3)' : isBalanced ? 'var(--blue)' : isReceive ? 'var(--green)' : 'var(--red)';
  const bgClr      = isSettled ? 'rgba(107,114,128,.15)' : isBalanced ? 'rgba(var(--blue-rgb),.15)' : isReceive ? 'rgba(52,168,83,.18)' : 'rgba(234,67,53,.18)';
  const initial    = g.person.charAt(0).toUpperCase();
  const statusText = isSettled ? 'Settled' : isBalanced ? 'Balanced' : isReceive ? 'To Receive' : 'To Pay Back';
  const countText  = g.loans.length === 1 ? '1 loan' : `${g.loans.length} loans`;

  return `<div class="loan-card" onclick="openPersonLoans('${g.key.replace(/'/g,"\\'")}')">
    <div class="loan-card-header">
      <div class="loan-card-left">
        <div class="loan-person-avatar" style="background:${bgClr};color:${color}">${initial}</div>
        <div class="loan-person-info">
          <div class="loan-person-name">${g.person}</div>
          <div class="loan-person-meta">${countText}${g.activeCount>0 && g.settledCount>0 ? ` · ${g.settledCount} settled` : ''}</div>
        </div>
      </div>
      <div class="loan-card-right">
        <div class="loan-amount" style="color:${color}">${isSettled ? '✓' : fmt(Math.abs(g.net))}</div>
        <div style="font-size:10px;color:var(--text3);margin-top:2px">${statusText}</div>
      </div>
    </div>
  </div>`;
}

// ── LOAN CARD HTML (single loan — used inside a person's sheet) ──
// Title priority: remark → person's name → loan ID as a last resort
function loanTitle(l) {
  const remark = String(l.remarks || '').trim();
  if (remark && remark !== '-') return remark;
  return l.person || l.loanId || 'Loan';
}

function loanCardHTML(l) {
  const isLent    = (l.type || '').toLowerCase() === 'lent';
  const color     = isLent ? 'var(--green)' : 'var(--red)';
  const pending   = Number(l.pending || 0);
  const total     = Number(l.total   || 0);
  const paid      = total - pending;
  const pct       = total > 0 ? Math.round((paid / total) * 100) : 0;
  const typeLabel = isLent ? 'To Receive' : 'To Pay Back';
  const loanId    = l.loanId || '';
  const isSettled = pending <= 0;
  const title     = loanTitle(l);

  return `<div class="loan-card" onclick="openLoanAction('${loanId}')">
    <div class="loan-card-header">
      <div class="loan-card-left">
        <div class="loan-person-info">
          <div class="loan-person-name">${esc(title)}</div>
          <div class="loan-person-meta">${isSettled ? 'Settled' : typeLabel}</div>
        </div>
      </div>
      <div class="loan-card-right">
        <div class="loan-amount" style="color:${isSettled?'var(--text3)':color}">${isSettled ? 'Paid' : fmt(pending)}</div>
        <div style="font-size:10px;color:var(--text3);margin-top:2px">${pct}% settled</div>
      </div>
    </div>
    <div style="padding:0 16px 14px">
      <div style="height:4px;background:var(--border);border-radius:2px;overflow:hidden">
        <div style="height:100%;width:${pct}%;background:${isSettled?'var(--text3)':color};border-radius:2px"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text3);margin-top:5px">
        <span>Total: ${fmt(total)}</span>
        <span>Settled: ${fmt(paid)}</span>
      </div>
    </div>
    <div style="display:flex;justify-content:flex-end;padding:0 12px 10px;border-top:1px solid var(--border);padding-top:8px">
      <button onclick="event.stopPropagation();deleteLoanConfirm('${loanId}')"
        style="background:rgba(217,48,37,.08);border:1px solid rgba(217,48,37,.18);
        border-radius:8px;padding:6px 12px;cursor:pointer;color:var(--red);
        font-size:11px;font-weight:700;display:flex;align-items:center;gap:5px">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        Delete
      </button>
    </div>
  </div>`;
}

// ── PERSON LOANS SHEET (drill-down from a person card) ──
function openPersonLoans(key) {
  currentPersonKey = key;
  renderPersonLoans();
  document.getElementById('person-loans-overlay').classList.add('open');
}

function renderPersonLoans() {
  const groups = groupLoansByPerson(appData.loanSummary || []);
  const g = groups.find(x => x.key === currentPersonKey);
  if (!g) { closeOverlay('person-loans-overlay'); return; }

  const isSettled  = g.activeCount === 0;
  const isBalanced = !isSettled && g.net === 0;
  const isReceive  = g.net > 0;
  const color      = isSettled ? 'var(--text3)' : isBalanced ? 'var(--blue)' : isReceive ? 'var(--green)' : 'var(--red)';
  const statusText = isSettled ? 'All settled up' : isBalanced ? 'Balanced — even split' : isReceive ? 'Net to receive' : 'Net to pay back';

  document.getElementById('pl-header').innerHTML = `
    <div class="la-name">${g.person}</div>
    <div class="la-meta" style="color:${color};font-weight:700">${statusText}${isSettled ? '' : ' · ' + fmt(Math.abs(g.net))}</div>`;

  const loans = g.loans
    .filter(l => showSettledLoans || Number(l.pending||0) > 0)
    .sort((a,b) => Number(b.pending||0) - Number(a.pending||0));

  document.getElementById('pl-list').innerHTML = loans.length
    ? loans.map(l => loanCardHTML(l)).join('')
    : emptyState('Nothing to show', 'Turn on "Show settled" to see past loans');
}

// ── OPEN LOAN ACTION SHEET ──
function openLoanAction(loanId) {
  currentLoanAction = (appData.loanSummary || []).find(l => l.loanId === loanId);
  if (!currentLoanAction) return;
  const l = currentLoanAction;
  const isLent  = (l.type || '').toLowerCase() === 'lent';
  const color   = isLent ? 'var(--green)' : 'var(--red)';
  const pending = Number(l.pending || 0);
  const total   = Number(l.total   || 0);
  const paid    = total - pending;
  const pct     = total > 0 ? Math.round((paid / total) * 100) : 0;

  document.getElementById('la-header').innerHTML = `
    <div class="la-name">${esc(loanTitle(l))} <span style="font-size:12px;color:var(--text2);font-weight:500">${esc(l.person)}</span></div>
    <div class="la-meta">${isLent ? 'You lent money · To Receive' : 'You borrowed · To Pay Back'}</div>
    <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text2);margin-top:8px">
      <span>Total: ${fmt(total)}</span><span>Pending: <b style="color:${color}">${fmt(pending)}</b></span>
    </div>
    <div class="la-prog-bar"><div class="la-prog-fill" style="width:${pct}%;background:${color}"></div></div>
    <div class="la-prog-text"><span>${pct}% settled</span><span style="color:${color}">${pending <= 0 ? 'Settled ✓' : isLent ? 'Lent' : 'Borrowed'}</span></div>`;

  document.getElementById('la-submit-btn').textContent = isLent ? 'Mark Collected' : 'Mark Repaid';
  document.getElementById('la-date').value = todayISO();
  document.getElementById('la-amount').value = pending > 0 ? pending : '';
  document.getElementById('la-remarks').value = '';

  switchLaTab('repay');
  document.getElementById('loan-action-overlay').classList.add('open');
}

// ── SUBMIT LOAN ACTION (repay/collect) ──
async function submitLoanAction() {
  const l = currentLoanAction;
  if (!l) return;
  const date    = document.getElementById('la-date').value;
  const amount  = document.getElementById('la-amount').value;
  const pm      = document.getElementById('la-pm').value;
  const remarks = document.getElementById('la-remarks').value || '-';
  if (!date || !amount) { showToast('Fill required fields'); return; }
  const btn = document.getElementById('la-submit-btn');
  btn.disabled = true; btn.textContent = 'Saving...';
  try {
    const res = await api({
      action: 'repayLoan',
      userId: currentUser.id,
      loanId: l.loanId,
      date: fmtDateForSheet(date),
      amount, paymentMode: pm, remarks
    });
    if (res.success) {
      showToast('Payment recorded');
      closeOverlay('loan-action-overlay');
      clearCache();
      await loadAllData();
    } else { showToast('Error: ' + (res.error || 'Failed')); }
  } catch(e) { showToast('Connection error'); }
  btn.disabled = false;
  const isLent = (l.type || '').toLowerCase() === 'lent';
  btn.textContent = isLent ? 'Mark Collected' : 'Mark Repaid';
}

// ── RENDER LOAN HISTORY ──
function renderLoanHistory() {
  const l = currentLoanAction;
  if (!l) return;
  const loanId = l.loanId;
  // Filter loan rows for this loanId
  const rows = (appData.loans || []).filter(r => String(r['Loan ID'] || '').trim() === loanId)
    .sort((a, b) => parseSheetDate(b['Date']) - parseSheetDate(a['Date']));
  const el = document.getElementById('la-history-list');
  if (!rows.length) { el.innerHTML = '<div style="text-align:center;color:var(--text3);padding:20px">No history yet</div>'; return; }
  const isLent = (l.type || '').toLowerCase() === 'lent';
  el.innerHTML = rows.map(r => {
    const cat = String(r['Category'] || '');
    const isRepay = cat === 'Collected' || cat === 'Repaid';
    const color = isRepay ? 'var(--green)' : (isLent ? 'var(--red)' : 'var(--green)');
    return `<div class="loan-entry-item">
      <div>
        <div class="le-cat" style="color:${color}">${cat}</div>
        <div class="le-date">${fmtDisplay(r['Date'])} · ${r['Payment Mode'] || ''}</div>
        ${r['Remarks'] && r['Remarks'] !== '-' ? `<div class="le-date" style="color:var(--yellow)">${r['Remarks']}</div>` : ''}
      </div>
      <div class="le-amt" style="color:${color}">${fmt(Number(r['Loan Amount'] || 0))}</div>
    </div>`;
  }).join('');
}
