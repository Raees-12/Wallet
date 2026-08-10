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

// ── AUTO-FIT TEXT ──
// Big amounts must not overflow their container. Rather than pick one font size
// and hope, shrink until the text actually fits the space it has.
function fitText(el, maxPx, minPx, availablePx) {
  if (!el) return;
  const avail = Math.max(40, availablePx);
  let size = maxPx;
  el.style.fontSize = size + 'px';
  // Step down proportionally — a few passes beat pixel-by-pixel on long numbers
  let guard = 40;
  while (size > minPx && el.scrollWidth > avail && guard-- > 0) {
    const ratio = avail / el.scrollWidth;
    size = Math.max(minPx, Math.floor(size * Math.min(0.97, Math.max(0.7, ratio))));
    el.style.fontSize = size + 'px';
  }
  // Tighten the tracking a touch on the smallest sizes so digits stay legible
  el.style.letterSpacing = size < maxPx * 0.62 ? '-0.5px' : '';
}

function vw(pct) { return window.innerWidth * pct / 100; }

// Dashboard balance + the two monthly figures under it
function fitDashboardText() {
  const amt = document.getElementById('dash-balance');
  if (amt && amt.offsetParent !== null) {
    const row = amt.parentElement;
    // leave room for the eye button and its gap
    fitText(amt, Math.min(38, vw(8.6)), 17, row.clientWidth - 58);
  }
  ['dash-income', 'dash-expense'].forEach(id => {
    const el = document.getElementById(id);
    if (!el || el.offsetParent === null) return;
    const col = el.closest('.bc-col');
    fitText(el, 17, 11, (col ? col.clientWidth : 140) - 4);
  });
}

// The donut's centre label has to sit inside the ring, not across it
function fitSummaryText() {
  const el = document.getElementById('summary-total');
  const donut = document.getElementById('summary-donut');
  if (!el || !donut || el.offsetParent === null) return;
  // Ring: r=88, stroke 9 in a 200 viewBox → inner diameter is 167/200 of the box
  const inner = donut.clientWidth * (167 / 200);
  fitText(el, Math.min(52, vw(11.5)), 16, inner * 0.92);
}

function fitAllText() { fitDashboardText(); fitSummaryText(); }

let _fitTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_fitTimer);
  _fitTimer = setTimeout(fitAllText, 120);
});

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
// ══════════════════════════════════════════════════════════════
// REMEMBERED ACCOUNTS (device-local)
//
// Supabase holds one live session per browser. This is only a convenience list
// of accounts previously used on this device so the switcher can offer them —
// it stores no tokens and grants no access on its own.
// ══════════════════════════════════════════════════════════════
const ACCOUNTS_KEY  = 'wallet_accounts_v1';
const SESSIONS_KEY  = 'wallet_sessions_v1';
const LAST_USER_KEY = 'wallet_last_user_v1';
let accounts = [];                // [{ id, username, email }]

// Supabase keeps one live session per browser, but it can be handed a different
// one at runtime. Storing each account's refresh token lets switching happen
// without asking for a password again. These are the same tokens Supabase
// already keeps in localStorage for the active session — no extra exposure.
function loadSessions() {
  try { return JSON.parse(localStorage.getItem(SESSIONS_KEY) || '{}') || {}; }
  catch(e) { return {}; }
}
function saveSessionFor(userId, session) {
  if (!userId || !session || !session.refresh_token) return;
  try {
    const all = loadSessions();
    all[userId] = {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      savedAt: Date.now(),
    };
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(all));
  } catch(e) {}
}
function forgetSessionFor(userId) {
  try {
    const all = loadSessions();
    delete all[userId];
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(all));
  } catch(e) {}
}

// Remembering who was last signed in lets the app paint their cached dashboard
// immediately instead of showing a spinner while the session is verified.
function rememberLastUser(u) {
  try { localStorage.setItem(LAST_USER_KEY, JSON.stringify(u)); } catch(e) {}
}
function loadLastUser() {
  try { return JSON.parse(localStorage.getItem(LAST_USER_KEY) || 'null'); }
  catch(e) { return null; }
}
function forgetLastUser() {
  try { localStorage.removeItem(LAST_USER_KEY); } catch(e) {}
}

// Supabase writes its session under sb-<project-ref>-auth-token. Spotting that
// synchronously tells us a session probably exists before any async work.
function hasStoredSession() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && /^sb-.*-auth-token$/.test(k)) return true;
    }
  } catch(e) {}
  return false;
}

function loadAccounts() {
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY);
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) return list.filter(a => a && a.id);
    }
  } catch(e) {}
  return [];
}

function persistAccounts() {
  try { localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts)); } catch(e) {}
}

function upsertAccount(u) {
  if (!u || !u.id) return;
  const entry = { id: u.id, username: u.username || 'User', email: u.email || '' };
  const i = accounts.findIndex(a => String(a.id) === String(u.id));
  if (i >= 0) accounts[i] = entry; else accounts.push(entry);
  persistAccounts();
}

function dropAccount(id) {
  accounts = accounts.filter(a => String(a.id) !== String(id));
  persistAccounts();
}

function clearCacheFor(id) {
  try { localStorage.removeItem('wallet_cache_' + id); } catch(e) {}
}

// ══════════════════════════════════════════════════════════════
// AUTHENTICATION — Supabase Auth (email OTP + Google)
//
// Supabase owns credentials and session storage. We never persist tokens
// ourselves and never send a user id to the API: the server reads it from the
// verified JWT instead.
// ══════════════════════════════════════════════════════════════
let sb = null;                    // Supabase client, created after /api/config
let authReady = null;             // resolves once the client exists
let _authStep = 'welcome';
let _authMode = 'login';          // 'login' | 'signup'

let _authInitError = null;        // remembered so it can be shown on any screen

async function initSupabase() {
  if (sb) return sb;

  // The SDK comes from a CDN — if that request failed, say so plainly rather
  // than dying later on `sb.auth`.
  if (!window.supabase || !window.supabase.createClient) {
    throw new Error("Couldn't load the sign-in library. Check your connection and reload.");
  }

  let cfg;
  try {
    const res = await fetch('/api/config', { cache: 'no-store' });
    const body = await res.text();
    try { cfg = JSON.parse(body); } catch(e) { cfg = null; }
    if (!res.ok) {
      // api/config reports exactly which variable is missing — pass it through
      throw new Error((cfg && cfg.error) || `Server config error (${res.status})`);
    }
  } catch(e) {
    if (String(e.message).includes('Failed to fetch')) {
      throw new Error("Can't reach the server. Check your connection and try again.");
    }
    throw e;
  }

  if (!cfg || !cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    throw new Error('Supabase is not configured on the server (SUPABASE_URL / SUPABASE_ANON_KEY).');
  }

  sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: {
      persistSession: true,        // Supabase's own storage — survives reloads
      autoRefreshToken: true,      // keeps long sessions alive
      detectSessionInUrl: true,    // completes the Google redirect
      flowType: 'pkce',
    },
  });
  _authInitError = null;
  return sb;
}

/**
 * Every auth call goes through here. Waiting on `authReady` alone was unsafe:
 * before startup finished it was null, and `await null` resolves immediately —
 * so the code carried on with a null client and blew up on `sb.auth`.
 * This creates the client on demand and retries after a previous failure.
 */
async function ensureSupabase() {
  if (sb) return sb;
  if (!authReady) authReady = initSupabase();
  try {
    await authReady;             // the in-flight init promise, NOT this function
  } catch(e) {
    _authInitError = e;
    authReady = null;              // let the next attempt try again
    throw e;
  }
  if (!sb) {
    const err = new Error('Sign-in is unavailable right now. Please reload.');
    _authInitError = err;
    throw err;
  }
  return sb;
}

async function getAccessToken() {
  try { await ensureSupabase(); } catch(e) { return null; }
  const { data } = await sb.auth.getSession();
  return data && data.session ? data.session.access_token : null;
}

// ── Screen steps ──
function showAuthStep(step) {
  _authStep = step;
  ['welcome','form','reset','loading'].forEach(k => {
    const el = document.getElementById('auth-step-' + k);
    if (el) el.style.display = (k === step) ? 'block' : 'none';
  });
  if (step === 'form') setTimeout(() => {
    const em = document.getElementById('auth-email');
    if (em && !em.value) em.focus();
  }, 140);
}

// Log in and sign up share one form — only the copy and the call differ.
function setAuthMode(mode) {
  _authMode = mode;
  const signup = mode === 'signup';
  document.getElementById('auth-form-title').textContent = signup ? 'Create account' : 'Log in';
  document.getElementById('auth-form-sub').textContent = signup
    ? 'Just an email and a password — you can add the rest later.'
    : 'Welcome back.';
  document.getElementById('auth-submit-btn').textContent = signup ? 'Create account' : 'Log in';
  document.getElementById('auth-pass').setAttribute('autocomplete',
    signup ? 'new-password' : 'current-password');
  document.getElementById('auth-pass').placeholder =
    signup ? 'At least 8 characters' : 'Your password';
  document.getElementById('auth-pass-hint').style.display = signup ? 'block' : 'none';
  document.getElementById('auth-forgot').style.display = signup ? 'none' : 'inline';
  document.getElementById('auth-switch-text').textContent = signup
    ? 'Already have an account?' : 'New here?';
  document.getElementById('auth-switch-btn').textContent = signup
    ? 'Log in' : 'Create an account';
  // A startup failure stays on screen — it's the reason nothing will work
  authError('auth-form-err', _authInitError ? friendlyAuthError(_authInitError) : '');
  authOK('auth-form-ok', '');
  const help = document.getElementById('auth-help');
  if (help) help.style.display = 'none';
}

function toggleAuthMode() { setAuthMode(_authMode === 'signup' ? 'login' : 'signup'); }

function togglePw() {
  const el = document.getElementById('auth-pass');
  el.type = el.type === 'password' ? 'text' : 'password';
}

function authError(id, msg) {
  const el = document.getElementById(id);
  if (el) el.textContent = msg || '';
}
function authOK(id, msg) {
  const el = document.getElementById(id);
  if (el) el.textContent = msg || '';
}

// Turns Supabase's raw errors into something a person can act on
function friendlyAuthError(e) {
  const raw = String((e && e.message) || e || '');
  const m = raw.toLowerCase();
  // Anything null-ish means the client never came up — surface the real cause
  if (m.includes("reading 'auth'") || m.includes('of null') || m.includes('of undefined')) {
    return _authInitError
      ? _authInitError.message
      : 'Sign-in is still starting up. Give it a second and try again.';
  }
  // Only trust this when the browser explicitly says offline; undefined means
  // "unknown", not "disconnected".
  if (typeof navigator !== 'undefined' && navigator.onLine === false)
                                             return "You're offline — check your connection.";
  if (m.includes('rate limit') || m.includes('too many') || m.includes('429') ||
      m.includes('for security purposes'))
                                             return 'Too many attempts. Wait a minute and try again.';
  if (m.includes('expired'))                 return 'That code has expired. Send a new one.';
  if (m.includes('invalid') && m.includes('token'))
                                             return "That code isn't right. Check and try again.";
  if (m.includes('otp') || m.includes('token')) return "That code isn't right or has already been used.";
  if (m.includes('email') && m.includes('invalid')) return 'That email address looks wrong.';
  // These two are Supabase project switches, not user mistakes — say where to fix it
  if (m.includes('email logins are disabled') || m.includes('email logins disabled') ||
      m.includes('provider is not enabled') || m.includes('email provider'))
    return 'Email sign-in is switched off in Supabase. Enable it under Authentication → Sign In / Providers → Email.';
  if (m.includes('signups not allowed') || m.includes('email signups are disabled') ||
      m.includes('signup is disabled') || m.includes('signups disabled'))
    return 'New sign-ups are switched off in Supabase. Enable "Allow new users to sign up" under Authentication → Sign In / Providers.';
  // Supabase returns the same message whether the account doesn't exist, the
  // password is wrong, or the email is unconfirmed — it won't reveal which.
  if (m.includes('invalid login credentials'))
    return 'Wrong email or password. If you have not created an account yet, tap "Create an account" below.';
  if (m.includes('already registered') || m.includes('already been registered'))
                                             return 'That email already has an account — log in instead.';
  if (m.includes('password') && m.includes('short'))
                                             return 'Passwords need at least 8 characters.';
  if (m.includes('weak password'))           return 'Pick a stronger password.';
  if (m.includes('email not confirmed'))     return 'Confirm your email first — check your inbox.';
  if (m.includes('failed to fetch') || m.includes('network'))
                                             return 'Network problem — please try again.';
  return raw || 'Something went wrong. Please try again.';
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ── Email + password ──
async function submitAuthForm() {
  const email = document.getElementById('auth-email').value.trim().toLowerCase();
  const pass  = document.getElementById('auth-pass').value;
  authError('auth-form-err', ''); authOK('auth-form-ok', '');
  const help = document.getElementById('auth-help');
  if (help) help.style.display = 'none';

  if (!EMAIL_RE.test(email)) { authError('auth-form-err', "That doesn't look like a valid email"); return; }
  if (!pass)                 { authError('auth-form-err', 'Enter your password'); return; }
  if (_authMode === 'signup' && pass.length < 8) {
    authError('auth-form-err', 'Passwords need at least 8 characters'); return;
  }

  const btn = document.getElementById('auth-submit-btn');
  const label = btn.textContent;
  btn.textContent = _authMode === 'signup' ? 'Creating…' : 'Signing in…';
  btn.disabled = true;
  try {
    await ensureSupabase();
    if (_authMode === 'signup') {
      const { data, error } = await sb.auth.signUp({ email, password: pass });
      if (error) throw error;
      if (data.session) {
        await onSignedIn();
      } else {
        // Email confirmation is switched on in Supabase — see the setup notes
        authOK('auth-form-ok',
          'Account created. Confirm your email from the link we sent, then log in.');
        setAuthMode('login');
      }
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password: pass });
      if (error) throw error;
      await onSignedIn();
    }
  } catch(e) {
    authError('auth-form-err', friendlyAuthError(e));
    if (_authMode === 'login' && /invalid login credentials/i.test(e.message || '')) {
      showLoginHelp(email);
    }
  }
  btn.textContent = label; btn.disabled = false;
}

// Shown only after a failed login. Supabase deliberately won't say whether the
// account exists, so we surface the two things that actually fix it.
function showLoginHelp(email) {
  const el = document.getElementById('auth-help');
  if (!el) return;
  el.style.display = 'block';
  el.innerHTML = `
    <b>Can't get in?</b>
    <div>· No account yet for <b>${esc(email)}</b>? Tap <b>Create an account</b>.</div>
    <div>· Just signed up? Confirm your email first, then log in.</div>
    <div>· Forgotten it? Use <b>Forgot password?</b> above.</div>`;
}

// ── Forgot password ──
async function forgotPassword() {
  const email = document.getElementById('auth-email').value.trim().toLowerCase();
  authError('auth-form-err', ''); authOK('auth-form-ok', '');
  if (!EMAIL_RE.test(email)) {
    authError('auth-form-err', 'Enter your email first, then tap Forgot password'); return;
  }
  try {
    await ensureSupabase();
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin,
    });
    if (error) throw error;
    authOK('auth-form-ok', 'Reset link sent — check your inbox.');
  } catch(e) {
    authError('auth-form-err', friendlyAuthError(e));
  }
}

async function saveNewPassword() {
  const pass = document.getElementById('auth-newpass').value;
  authError('auth-reset-err', '');
  if (pass.length < 8) { authError('auth-reset-err', 'At least 8 characters'); return; }
  const btn = document.getElementById('auth-reset-btn');
  btn.textContent = 'Saving…'; btn.disabled = true;
  try {
    await ensureSupabase();
    const { error } = await sb.auth.updateUser({ password: pass });
    if (error) throw error;
    
    await onSignedIn();
  } catch(e) {
    authError('auth-reset-err', friendlyAuthError(e));
  }
  btn.textContent = 'Save password'; btn.disabled = false;
}

// ── Email OTP ──






// ── Google ──

// ── Post sign-in ──
// The server tells us who we are; we never assert an identity ourselves.
async function onSignedIn(silent) {
  // `silent` = the dashboard is already on screen from cache; don't flash the
  // loading page over it just to confirm the session.
  if (!silent) {
    showAuthStep('loading');
    showScreen('login-screen');
  }
  try {
    const res = await api({ action: 'me' });
    if (!res.success) throw new Error(res.error || 'Could not load your profile');
    currentUser = res.user;
    upsertAccount(currentUser);
    rememberLastUser(currentUser);
    await persistCurrentSession();
    if (!silent) {
      resetAppState();
      initMainScreen();
      switchPage('dashboard');
      showScreen('main-screen');
    } else {
      initMainScreen();
    }
    loadAllData();
  } catch(e) {
    authError('auth-form-err', friendlyAuthError(e));
    showAuthStep('welcome');
    showScreen('login-screen');
  }
}

/**
 * Ends the current session.
 *
 * `forget: false` is what account switching uses. It keeps the stored refresh
 * token and signs out with scope 'local' — the default 'global' scope revokes
 * every refresh token for that user on Supabase's servers, which would kill the
 * very token we're trying to come back with.
 */
async function signOut({ forget = true } = {}) {
  if (currentUser) {
    if (forget) {
      forgetSessionFor(currentUser.id);
    } else {
      // Capture the latest token before the session is torn down
      try {
        const { data } = await sb.auth.getSession();
        if (data && data.session) saveSessionFor(currentUser.id, data.session);
      } catch(e) {}
    }
  }
  forgetLastUser();
  try {
    await ensureSupabase();
    await sb.auth.signOut(forget ? {} : { scope: 'local' });
  } catch(e) {}
  clearCache();
  currentUser = null;
  appData = { expenses:[], income:[], loans:[], loanSummary:[], emis:[], emiPayments:[], accounts:[], config:{} };
  _pendingEmail = '';
  ['auth-email','auth-pass','auth-newpass'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  ['auth-form-err','auth-reset-err'].forEach(id => authError(id, ''));
  authOK('auth-form-ok', '');
  setAuthMode('login');
  showAuthStep('welcome');
  showScreen('login-screen');
}

// Called when a request comes back 401 — the session died mid-use
async function handleSessionExpired() {
  showToast('Session expired — please sign in again');
  // forget:false — only this session died; other accounts keep their tokens
  await signOut({ forget: false });
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

function setAccent(hex, silent) {
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
  // `silent` means the value came from storage or the server, so there's
  // nothing new to push back.
  if (!silent) { prefs.accent = hex; persistPrefs(); }

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

// Dashboard quick actions — open the add sheet straight on the right tab
function quickAdd(type) {
  openAddModal();
  switchAddTab(type);
  buzz(8);
}

// ── AVATAR GESTURES ──
// Settings has its own button in the header now, so the avatar is purely
// about identity:
//   Tap        → open the account picker
//   Double-tap → jump straight to the next account
let _tapTimer       = null;
let _longPressFired = false;
let _pointerMoved   = false;
let _pointerStart   = null;
const DOUBLE_TAP_MS = 280;

function initAvatarGestures(id) {
  const av = document.getElementById(id || 'topbar-avatar');
  if (!av) return;

  // Stop the OS text-selection / callout menu that a double-tap normally triggers
  av.addEventListener('contextmenu', e => e.preventDefault());
  av.addEventListener('selectstart', e => e.preventDefault());
  av.addEventListener('dblclick',    e => e.preventDefault());

  av.addEventListener('pointerdown', e => {
    _longPressFired = false;
    _pointerMoved   = false;
    _pointerStart   = { x: e.clientX, y: e.clientY };
  });

  // A drag/scroll shouldn't count as a press
  av.addEventListener('pointermove', e => {
    if (!_pointerStart) return;
    if (Math.abs(e.clientX - _pointerStart.x) > 10 || Math.abs(e.clientY - _pointerStart.y) > 10) {
      _pointerMoved = true;
    }
  });

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
    openAccountSwitcher();
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
  closeMore(true);
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
   'entry-detail-overlay','cat-entries-overlay',
   'datepick-overlay','type-overlay','period-overlay','catfilter-overlay',
   'anaperiod-overlay','day-overlay','budget-overlay',
   'import-overlay','clear-overlay','catbudget-overlay','delacct-overlay'].forEach(id => {
    const o = document.getElementById(id); if (o) o.classList.remove('open');
  });
  const out = document.getElementById('report-output');
  if (out) out.innerHTML = '<div class="report-placeholder">Select a period and generate your report</div>';
  const expBtns = document.getElementById('report-export-btns');
  if (expBtns) expBtns.style.display = 'none';
  updateEyeIcon();
  renderAll();
}

// Switching reuses that account's stored refresh token, so no password is
// needed. Only if the token has expired or been revoked do we fall back to
// asking them to sign in again.
async function switchAccount(id) {
  const a = accounts.find(x => String(x.id) === String(id));
  if (!a) return;
  closeOverlay('account-overlay');
  closeSettings();
  if (currentUser && String(currentUser.id) === String(id)) return;

  const stored = loadSessions()[a.id];
  if (!stored || !stored.refresh_token) {
    // Never signed in to this account on this device since sessions were kept
    return askToSignInAs(a, 'first');
  }

  
  try {
    await ensureSupabase();

    // Preserve the account we're leaving so switching back is instant too
    if (currentUser) await persistCurrentSession();

    const session = await activateSession(stored);
    if (!session) throw new Error('could not activate');

    // Refresh tokens rotate on use — store the replacement, or the next switch
    // back to this account would fail.
    saveSessionFor(a.id, session);

    _defaultAccountApplied = false;
    anaAccount = null;
    currentUser = { id: a.id, username: a.username, email: a.email };
    loadPrefsFor();
    resetAppState();
    await onSignedIn(true);
    switchPage('dashboard');
    showScreen('main-screen');
    
  } catch(e) {
    console.warn('switchAccount failed:', e && e.message);
    forgetSessionFor(a.id);
    askToSignInAs(a, 'expired');
  }
}

/**
 * Makes a stored session the live one.
 *
 * setSession is tried first. If the access token has already expired it can
 * fail outright, so refreshSession with the refresh token is tried as a second
 * attempt before giving up — that path only needs the refresh token to be valid.
 */
async function activateSession(stored) {
  try {
    const { data, error } = await sb.auth.setSession({
      access_token: stored.access_token || '',
      refresh_token: stored.refresh_token,
    });
    if (!error && data && data.session) return data.session;
  } catch(e) {}

  try {
    const { data, error } = await sb.auth.refreshSession({
      refresh_token: stored.refresh_token,
    });
    if (!error && data && data.session) return data.session;
  } catch(e) {}

  return null;
}

// Writes whatever session is live right now against the signed-in account
async function persistCurrentSession() {
  if (!currentUser || !sb) return;
  try {
    const { data } = await sb.auth.getSession();
    if (data && data.session) saveSessionFor(currentUser.id, data.session);
  } catch(e) {}
}

// Fallback when there's no usable session for that account
function askToSignInAs(a, why) {
  const reason = why === 'first'
    ? "This account hasn't been signed in on this device yet, so you'll need your password this once. After that, switching is instant."
    : "That saved session is no longer valid, so you'll need your password once more.";
  showConfirm(
    `Sign in as ${a.username}?\n\n${reason}`,
    async () => {
      const mail = a.email || '';
      await signOut({ forget: false });   // the account we're leaving stays signed in
      if (mail) document.getElementById('auth-email').value = mail;
      setAuthMode('login');
      showAuthStep('form');
    }, 'Continue');
}

function startAddAccount() {
  closeOverlay('account-overlay');
  closeSettings();
  showConfirm(
    'Add another account?\n\nThis one stays signed in — you can switch back any time.',
    async () => {
      await signOut({ forget: false });   // keep this account's session alive
      setAuthMode('login');
      showAuthStep('form');
    },
    'Continue');
}


function removeAccountConfirm(id, name) {
  showConfirm(
    `Remove ${name} from this device?\n\nThe account's data stays safe — you'll just need the password to add it back.`,
    () => {
      clearCacheFor(id);
      dropAccount(id);
      if (currentUser && String(currentUser.id) === String(id)) {
        if (accounts.length) { switchAccount(accounts[0].id); return; }
        currentUser = null;
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
      accounts.forEach(a => { clearCacheFor(a.id); forgetSessionFor(a.id); });
      accounts = [];
      persistAccounts();
      closeOverlay('account-overlay');
      signOut();
    },
    'Log out'
  );
}

// Small dot on the avatar hinting that more than one account is available
function updateAccountBadge() {
  ['hero-avatar'].forEach(id => {
    const av = document.getElementById(id);
    if (av) av.classList.toggle('multi', accounts.length > 1);
  });
  if (_settingsOpen) { renderSettings(); renderAccountRows('settings-accounts-list'); }
}

// ── INIT ──
document.addEventListener('DOMContentLoaded', async () => {
  applyTheme(loadTheme(), true);
  setAccent(loadAccent(), true);
  balanceHidden = prefs.hideBalance;
  updateEyeIcon();
  initAvatarGestures('hero-avatar');
  initAnaSwipes();
  accounts = loadAccounts();

  // If a session almost certainly exists, paint that account's cached dashboard
  // straight away. Verification happens underneath, so there's no spinner.
  const last = loadLastUser();
  const warmStart = hasStoredSession() && last && last.id;

  if (warmStart) {
    currentUser = last;
    loadPrefsFor();
    initMainScreen();
    switchPage('dashboard');
    showScreen('main-screen');
  } else {
    showAuthStep('loading');
    document.getElementById('auth-loading-text').textContent = 'Starting up…';
  }

  try {
    authReady = initSupabase();
    await authReady;
  } catch(e) {
    _authInitError = e;
    setAuthMode('login');
    showAuthStep('welcome');
    showScreen('login-screen');
    showToast(friendlyAuthError(e));
    return;
  }

  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') { showAuthStep('reset'); showScreen('login-screen'); return; }
    // Tokens rotate in the background — keep the stored copy current
    if (event === 'TOKEN_REFRESHED' && session && currentUser) {
      saveSessionFor(currentUser.id, session);
    }
    if (event === 'SIGNED_IN' && session && !currentUser) onSignedIn();
    if (event === 'SIGNED_OUT' && currentUser) {
      currentUser = null;
      setAuthMode('login');
      showAuthStep('welcome');
      showScreen('login-screen');
    }
  });

  const { data } = await sb.auth.getSession();
  if (data && data.session) {
    await onSignedIn(warmStart);          // silent when the dashboard is already up
    await persistCurrentSession();        // make sure this account is switch-ready
  } else if (warmStart) {
    // The optimistic guess was wrong — the session is gone
    currentUser = null;
    forgetLastUser();
    setAuthMode('login');
    showAuthStep('welcome');
    showScreen('login-screen');
  } else {
    setAuthMode('login');
    showAuthStep('welcome');
    showScreen('login-screen');
  }
  updateAccountBadge();
});

// ── AUTH ──

function initMainScreen() {
  const u = currentUser;
  if (_prefsLoadedFor !== u.id) loadPrefsFor();
  const initial = u.username[0].toUpperCase();
  const hero = document.getElementById('hero-avatar');
  if (hero) hero.textContent = initial;
  renderHeader();
  updateAccountBadge();
}

// Logs out of the CURRENT account only. If other accounts are signed in on
// this device, we hop straight to the next one instead of dumping the user
// back at the login screen.
function doLogout() {
  closeSettings();
  if (currentUser) {
    clearCacheFor(currentUser.id);
    forgetSessionFor(currentUser.id);
    dropAccount(currentUser.id);
  }
  signOut();
}

// ── API ──
async function api(params) {
  const token = await getAccessToken();
  if (!token) { await handleSessionExpired(); throw new Error('Not signed in'); }
  const url = new URL(API_URL, window.location.origin);
  // userId is never sent — the server derives it from the token
  Object.entries(params).forEach(([k,v]) => { if (k !== 'userId') url.searchParams.set(k,v); });
  const res = await fetch(url.toString(), { headers: { Authorization: 'Bearer ' + token } });
  if (res.status === 401) { await handleSessionExpired(); throw new Error('Session expired'); }
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
    applyDefaultAccount();
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
    const fetchedFor = currentUser.id;
    const res = await api({ action: 'getAllData', userId: fetchedFor });
    if (!res.success) throw new Error(res.error || 'API error');
    // If the user switched accounts while this was in flight, drop the result
    if (!currentUser || String(currentUser.id) !== String(fetchedFor)) return;

    appData.expenses    = res.expenses    || [];
    appData.income      = res.income      || [];
    appData.loans       = res.loans       || [];
    appData.loanSummary = res.loanSummary || [];
    appData.config      = res.config      || {};
    appData.emis        = res.emis        || [];
    appData.emiPayments = res.emiPayments || [];
    appData.accounts    = res.accounts    || [];
    applyServerSettings(res.settings, fetchedFor);
    applyDefaultAccount();

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
      accounts: data.accounts,
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
      markCatClean();
      renderCatList();
      clearCache();
      await refreshFromAPI();      // keep appData.config in step with the server
      renderAll();
    } else { showToast(res.error || 'Could not save categories'); }
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
  icon.innerHTML = balanceHidden
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
}

// ── TOAST ──
function showToast(msg,dur=2500){
  const t=document.getElementById('toast');
  t.textContent=msg;t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),dur);
}

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
      if (res.newStatus === 'Closed') showToast('EMI fully paid');   // worth knowing
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
      if (res.success) {  closeOverlay('emi-action-overlay'); await loadAllData(); }
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
// Pages reached through the More panel light up the More button instead of
// having a nav slot of their own.
const MORE_PAGES = ['loans', 'emis', 'budget'];

function switchPage(page) {
  currentPage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const el = document.getElementById('page-' + page);
  if (el) el.classList.add('active');
  const navKey = MORE_PAGES.includes(page) ? 'more' : page;
  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.page === navKey);
  });
  if (page === 'budget') renderBudgetPage();
}

// ══════════════════════════════════════════════════════════════
// MORE PANEL
// ══════════════════════════════════════════════════════════════
let _moreOpen = false;

function openMore() {
  const ls = appData.loanSummary || [];
  const pend = ls.filter(l => Number(l.pending) > 0).length;
  const emiActive = (appData.emis || []).filter(e => String(e['Status']) !== 'Closed').length;
  document.getElementById('more-loan-sub').textContent =
    pend ? `${pend} still open` : 'Money in and out';
  document.getElementById('more-emi-sub').textContent =
    emiActive ? `${emiActive} running` : 'Instalments';
  document.getElementById('more-budget-sub').textContent =
    prefs.budget ? fmt(prefs.budget) + ' limit' : 'Set limits';

  document.getElementById('more-backdrop').classList.add('open');
  document.getElementById('more-panel').classList.add('open');
  _moreOpen = true;
  buzz(8);
  try { history.pushState({ walletMore: true }, ''); } catch(e) {}
}

function closeMore(skipHistory) {
  if (!_moreOpen) return;
  _moreOpen = false;
  document.getElementById('more-backdrop').classList.remove('open');
  document.getElementById('more-panel').classList.remove('open');
  if (!skipHistory) {
    try { if (history.state && history.state.walletMore) history.back(); } catch(e) {}
  }
}

function goMore(page) {
  closeMore();
  setTimeout(() => switchPage(page), 120);
}

// ── OVERLAY HELPERS ──
function closeOverlay(id, event) {
  if (event && event.target !== document.getElementById(id)) return;
  document.getElementById(id).classList.remove('open');
}

// ══════════════════════════════════════════════════════════════
// ADD ENTRY — keypad screen
// One screen for all four kinds of entry. The amount is driven by the pad;
// everything else is a chip that opens a small picker.
// ══════════════════════════════════════════════════════════════
const KP_TABS = ['expense', 'income', 'loan', 'emi'];
let kp = null;                     // working entry

function kpDefaults(tab) {
  return {
    tab,
    amount: '',
    date: new Date(),
    category: '',
    desc: '',
    pm: tab === 'income' ? 'Net Banking' : 'UPI',
    account: '',
    loanType: 'Lent',
    person: '',
    remarks: '',
  };
}

function switchAddTab(tab) {
  if (tab === 'emi') {                     // EMIs have their own richer form
    closeFullPage('add-overlay');
    setTimeout(openEMIAddModal, 180);
    return;
  }
  currentAddTab = tab;
  const keep = kp ? { amount: kp.amount, date: kp.date } : {};
  kp = Object.assign(kpDefaults(tab), keep);
  kp.category = defaultCategoryFor(tab);
  document.querySelectorAll('#add-tabs .kp-tab').forEach((t, i) =>
    t.classList.toggle('active', KP_TABS[i] === tab));
  renderKeypadScreen();
}

function defaultCategoryFor(tab) {
  const list = getActiveCategories(tab === 'income' ? 'income' : tab === 'loan' ? 'loan' : 'expense');
  return list && list.length ? list[0] : '';
}

// ── Date strip ──
// A scrollable run of days ending at the selected one, so stepping back a few
// days is a swipe and there's always a way back to today.
function renderDayStrip() {
  const el = document.getElementById('kp-days');
  if (!el) return;
  const names = ['sun','mon','tue','wed','thu','fri','sat'];
  const sel   = startOfDay(kp.date);
  const today = startOfDay(new Date());

  // The window always ends on the selected day, so a date picked from the
  // calendar is visible and highlighted no matter how far back it is.
  const end   = sel;
  const days  = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(end); d.setDate(end.getDate() - i);
    days.push(d);
  }

  el.innerHTML = days.map(d => {
    const on = d.getTime() === sel.getTime();
    const isToday = d.getTime() === today.getTime();
    return `<button class="kp-day ${on ? 'on' : ''}" data-on="${on}" onclick="kpSetDate(${d.getTime()})">
      <span class="kp-day-n">${d.getDate()}</span>
      <span class="kp-day-w">${isToday ? 'today' : names[d.getDay()]}</span>
    </button>`;
  }).join('');

  // Keep the chosen day in view
  const active = el.querySelector('[data-on="true"]');
  if (active) {
    el.scrollLeft = active.offsetLeft - (el.clientWidth / 2) + (active.offsetWidth / 2);
  }
  const todayBtn = document.getElementById('kp-today');
  if (todayBtn) todayBtn.style.display = sel.getTime() === today.getTime() ? 'none' : 'block';
}

function startOfDay(d) {
  const x = new Date(d); x.setHours(0,0,0,0); return x;
}

function kpSetDate(ts) {
  kp.date = new Date(ts);
  buzz(6);
  renderDayStrip();
}

function kpGoToday() {
  kp.date = new Date();
  buzz(8);
  renderDayStrip();
}

// The native picker needs a real input in the document — creating one on the
// fly and removing it immediately is what stopped this working.
function openDayPicker() {
  const inp = document.getElementById('kp-date-input');
  if (!inp) return;
  inp.value = toISO(kp.date);
  try {
    if (inp.showPicker) inp.showPicker();
    else { inp.focus(); inp.click(); }
  } catch(e) {
    inp.focus(); inp.click();
  }
}

function kpDateChosen(value) {
  if (!value) return;
  const [y, m, d] = value.split('-').map(Number);
  kp.date = new Date(y, m - 1, d);
  renderDayStrip();
}

function toISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ── Amount pad ──
// Bound to pointerdown rather than click: the ~100ms click delay on touch is
// what makes a keypad feel sluggish. Holding delete clears the whole amount.
let _kpHoldTimer = null;
let _kpHeld = false;
let _kpBound = false;

function initKeypad() {
  if (_kpBound) return;
  const pad = document.querySelector('.kp-pad');
  if (!pad) return;
  _kpBound = true;

  pad.addEventListener('pointerdown', e => {
    const btn = e.target.closest('[data-key]');
    if (!btn) return;
    e.preventDefault();                    // no focus ring, no synthetic click
    const key = btn.dataset.key;
    _kpHeld = false;
    kpPress(key);
    if (key === 'back') {
      clearTimeout(_kpHoldTimer);
      _kpHoldTimer = setTimeout(() => {
        _kpHeld = true;
        kp.amount = '';
        paintAmount();
        buzz(18);
      }, 420);
    }
  }, { passive: false });

  const stop = () => { clearTimeout(_kpHoldTimer); _kpHoldTimer = null; };
  ['pointerup','pointercancel','pointerleave'].forEach(ev =>
    pad.addEventListener(ev, stop));
  // Swallow the click that follows pointerdown so digits aren't entered twice
  pad.addEventListener('click', e => {
    if (e.target.closest('[data-key]')) e.preventDefault();
  });
}

function kpPress(k) {
  if (!kp) return;
  buzz(4);
  if (k === 'back') {
    kp.amount = kp.amount.slice(0, -1);
  } else if (k === '.') {
    if (!kp.amount.includes('.')) kp.amount = (kp.amount || '0') + '.';
  } else {
    const [, dec] = kp.amount.split('.');
    if (dec && dec.length >= 2) return;          // two decimal places is plenty
    if (kp.amount.replace('.', '').length >= 11) return;
    kp.amount = (kp.amount === '0' ? '' : kp.amount) + k;
  }
  paintAmount();
  authError('kp-err', '');
}

let _lastAmtLen = -1;

function paintAmount() {
  const el = document.getElementById('kp-amount');
  if (!el) return;
  const raw = kp.amount || '0';
  const [intPart, dec] = raw.split('.');
  const grouped = Number(intPart || 0).toLocaleString('en-IN');
  el.innerHTML = `₹${grouped}` +
    (raw.includes('.') ? `<span class="kp-dec">.${(dec || '').padEnd(2,'0').slice(0,2)}</span>` : '');
  // Re-fitting measures the DOM, so only do it when the length actually changed
  if (raw.length !== _lastAmtLen) {
    _lastAmtLen = raw.length;
    fitText(el, Math.min(46, vw(12)), 22, (el.parentElement.clientWidth || 340) - 20);
  }
}

// ── Chips ──
function renderKeypadScreen() {
  initKeypad();
  _lastAmtLen = -1;
  renderDayStrip();
  paintAmount();
  renderKpChips();
  authError('kp-err', '');
}

function renderKpChips() {
  const el = document.getElementById('kp-chips');
  if (!el) return;
  const chip = (icon, label, onclick, muted) =>
    `<button class="kp-chip ${muted ? 'muted' : ''}" onclick="${onclick}">
       <span class="kp-chip-ico">${icon}</span>${esc(label)}</button>`;

  const tag = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.6 13.4 12 22l-9-9V3h10z"/><circle cx="7.5" cy="7.5" r="1.5" fill="currentColor"/></svg>';
  const pen = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
  const card= '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>';
  const user= '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
  const swap= '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>';
  const note= '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/></svg>';

  let html = '';
  if (kp.tab === 'loan') {
    html += chip(swap, kp.loanType === 'Lent' ? 'I gave' : 'I took', 'toggleLoanType()');
    html += chip(user, kp.person || 'Who?', "openTextSheet('person')", !kp.person);
  } else {
    html += chip(tag, kp.category || 'Category', "openPicker('category')");
    html += chip(pen, kp.desc || 'Add a note', "openTextSheet('desc')", !kp.desc);
  }
  html += chip(card, kp.pm, "openPicker('pm')");
  if (hasAccounts()) {
    html += chip(card, kp.account || 'No account', "openPicker('account')", !kp.account);
  }
  html += chip(note, kp.remarks || 'Remarks', "openTextSheet('remarks')", !kp.remarks);
  el.innerHTML = html;
}

function toggleLoanType() {
  kp.loanType = kp.loanType === 'Lent' ? 'Borrowed' : 'Lent';
  buzz(8);
  renderKpChips();
}

// ── Pickers ──
let _pickKind = null;

function openPicker(kind) {
  _pickKind = kind;
  let title = 'Choose', opts = [], active = '';
  if (kind === 'category') {
    title = 'Category';
    opts = getActiveCategories(kp.tab === 'income' ? 'income' : 'expense');
    active = kp.category;
  } else if (kind === 'pm') {
    title = 'Payment mode';
    opts = ['UPI','Cash','Card','Net Banking','Cheque','Wallet','Auto Debit'];
    active = kp.pm;
  } else if (kind === 'account') {
    title = 'Account';
    opts = ['— No account —'].concat(accountsList().map(a => a.name));
    active = kp.account || '— No account —';
  }
  document.getElementById('pick-title').textContent = title;
  document.getElementById('pick-list').innerHTML = opts.map(o =>
    `<div class="opt-row ${o === active ? 'active' : ''}"
       onclick="choosePick('${esc(String(o)).replace(/'/g,"\\\\'")}')"><span>${esc(String(o))}</span></div>`
  ).join('');
  document.getElementById('pick-overlay').classList.add('open');
}

function choosePick(value) {
  if (_pickKind === 'category') kp.category = value;
  if (_pickKind === 'pm')       kp.pm = value;
  if (_pickKind === 'account')  kp.account = value.startsWith('—') ? '' : value;
  closeOverlay('pick-overlay');
  renderKpChips();
}

let _textKind = null;

function openTextSheet(kind) {
  _textKind = kind;
  const titles = { person:'Who is involved?', desc:'Add a note', remarks:'Remarks' };
  const holders = { person:'Name', desc:'What was it for?', remarks:'Anything worth remembering' };
  document.getElementById('text-title').textContent = titles[kind] || 'Add a note';
  const inp = document.getElementById('text-input');
  inp.placeholder = holders[kind] || '';
  inp.value = kind === 'person' ? kp.person : kind === 'remarks' ? kp.remarks : kp.desc;
  document.getElementById('text-overlay').classList.add('open');
  setTimeout(() => inp.focus(), 180);
}

function saveTextSheet() {
  const v = document.getElementById('text-input').value.trim();
  if (_textKind === 'person')       kp.person = v;
  else if (_textKind === 'remarks') kp.remarks = v;
  else                              kp.desc = v;
  closeOverlay('text-overlay');
  renderKpChips();
}

// ── Save ──
async function kpSubmit() {
  const amount = Number(kp.amount || 0);
  authError('kp-err', '');
  if (!amount || amount <= 0)  { authError('kp-err', 'Enter an amount'); buzz(20); return; }
  if (kp.tab === 'loan' && !kp.person) { authError('kp-err', 'Add who this is with'); openTextSheet('person'); return; }
  if (kp.tab !== 'loan' && !kp.category) { authError('kp-err', 'Pick a category'); openPicker('category'); return; }

  const date = fmtDMY(kp.date);
  let params, msg;
  if (kp.tab === 'expense') {
    params = { action:'addExpense', date, amount, category:kp.category,
      description:kp.desc || '-', paymentMode:kp.pm, remarks:kp.remarks || '-',
      account:kp.account || '' };
    msg = 'Expense added';
  } else if (kp.tab === 'income') {
    params = { action:'addIncome', date, amount, category:kp.category,
      description:kp.desc || '-', paymentMode:kp.pm, remarks:kp.remarks || '-',
      account:kp.account || '' };
    msg = 'Income added';
  } else {
    params = { action:'addLoan', date, amount, type:kp.loanType,
      person:kp.person, paymentMode:kp.pm, remarks:kp.remarks || '-' };
    msg = kp.loanType === 'Lent' ? 'Due recorded' : 'Borrowing recorded';
  }

  const ok = document.getElementById('kp-ok');
  ok.classList.add('busy'); ok.disabled = true;
  try {
    const res = await api(params);
    if (res.success) {
      buzz(14);                       // a short tap confirms it, no toast needed
      closeFullPage('add-overlay');
      await loadAllData();
    } else {
      authError('kp-err', res.error || 'Could not save');
    }
  } catch(e) {
    authError('kp-err', 'Connection problem — try again');
  }
  ok.classList.remove('busy'); ok.disabled = false;
}

function pageAddTab() {
  if (currentPage === 'loans') return 'loan';
  if (currentPage === 'emis')  return 'emi';
  return 'expense';
}

// Wallet stores dates as DD/MM/YYYY
function fmtDMY(d) {
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
}

function openAddModal(forceTab) {
  // Dues page → Dues, EMI page → the EMI form, anywhere else → Expense
  const tab = forceTab || pageAddTab();
  if (tab === 'emi') { openEMIAddModal(); return; }
  kp = kpDefaults(tab);
  kp.category = defaultCategoryFor(kp.tab);
  currentAddTab = kp.tab;
  document.querySelectorAll('#add-tabs .kp-tab').forEach((t, i) =>
    t.classList.toggle('active', KP_TABS[i] === kp.tab));
  renderKeypadScreen();
  openFullPage('add-overlay');
}



function closeAddModal() { closeFullPage('add-overlay'); }

// Shared open/close for the full-page panels so back always does the right thing
let _fullPageStack = [];

function openFullPage(id) {
  document.getElementById(id).classList.add('open');
  document.body.classList.add('no-scroll');
  _fullPageStack.push(id);
  try { history.pushState({ walletFull: id }, ''); } catch(e) {}
}

function closeFullPage(id) {
  const i = _fullPageStack.lastIndexOf(id);
  if (i === -1) return;
  _fullPageStack.splice(i, 1);
  document.getElementById(id).classList.remove('open');
  if (!_fullPageStack.length && !_settingsOpen) document.body.classList.remove('no-scroll');
  try { if (history.state && history.state.walletFull === id) history.back(); } catch(e) {}
}

function closeEMIAddModal() { closeFullPage('emi-add-overlay'); }

function openEMIAddModal() {
  openFullPage('emi-add-overlay');
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
  if (name === 'profile')    renderProfilePage();
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
  if (_moreOpen) { closeMore(true); return; }
  if (_txnOpen) {
    _txnOpen = false;
    document.getElementById('txn-screen').classList.remove('open');
    if (!_settingsOpen && !_notifOpen) document.body.classList.remove('no-scroll');
    return;
  }
  if (_fullPageStack.length) {
    const id = _fullPageStack.pop();
    document.getElementById(id).classList.remove('open');
    if (!_fullPageStack.length && !_settingsOpen && !_notifOpen) {
      document.body.classList.remove('no-scroll');
    }
    return;
  }
  // Notifications sits on its own history entry, above Settings
  if (_notifOpen) {
    _notifOpen = false;
    document.getElementById('notif-screen').classList.remove('open');
    if (!_settingsOpen) document.body.classList.remove('no-scroll');
    return;
  }
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

  const tags = [];
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

  const bv = document.getElementById('settings-budget-value');
  if (bv) {
    const nCat = Object.keys(prefs.catBudgets || {}).length;
    bv.textContent = prefs.budget ? fmt(prefs.budget)
      : nCat ? `${nCat} categories` : 'Not set';
  }
  document.getElementById('pref-carry').checked        = !!prefs.carryForward;
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
  clearCache();
  await refreshFromAPI();
  renderSettings();
  
}

function clearCacheConfirm() {
  showConfirm(
    'Clear the offline cache for this account?\n\nNothing on the server is touched — the app just re-downloads everything next time.',
    async () => { clearCache();  await refreshFromAPI(); renderSettings(); },
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
  bug:     ['Expenses','Income','Dues','EMIs','Reports','Sync / login','Appearance','Something else'],
  feature: ['Expenses','Income','Dues','EMIs','Reports','Budgets','Notifications','Something else']
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
// IMPORT / EXPORT — CSV
// One flat file of transactions. Loans and EMI payments already mirror
// themselves into expenses/income, so the money movement is all here.
// ══════════════════════════════════════════════════════════════
const CSV_HEADERS = ['Type','Date','Amount','Category','Description','Payment Mode','Account','Remarks'];

// Large payloads can't ride in a query string, so imports go over POST.
async function apiPost(params) {
  const token = await getAccessToken();
  if (!token) { await handleSessionExpired(); throw new Error('Not signed in'); }
  const { userId, ...safe } = params;      // identity comes from the token
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(safe)
  });
  if (res.status === 401) { await handleSessionExpired(); throw new Error('Session expired'); }
  const text = await res.text();
  try { return JSON.parse(text); }
  catch(e) { throw new Error('API error: ' + text.slice(0, 120)); }
}

// ── CSV helpers ──
function csvCell(v) {
  const t = String(v == null ? '' : v);
  return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}
function toCSV(headers, rows) {
  return [headers.join(',')]
    .concat(rows.map(r => headers.map(h => csvCell(r[h])).join(',')))
    .join('\r\n');
}

// Handles quoted fields, escaped quotes and newlines inside cells
function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', inQuotes = false;
  text = text.replace(/^\uFEFF/, '');            // strip BOM from Excel exports
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else cell += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(cell); cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(v => v !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some(v => v !== '')) rows.push(row);
  return rows;
}

function downloadFile(name, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Export ──
function exportData() {
  const rows = [];
  (appData.expenses || []).forEach(r => rows.push({
    Type: 'Expense',
    Date: r['Date'],
    Amount: Number(r['Expense Amount'] || 0),
    Category: r['Category'] || '',
    Description: r['Description'] || '',
    'Payment Mode': r['Payment Mode'] || '',
    Account: r['Account'] || '',
    Remarks: r['Remarks'] === '-' ? '' : (r['Remarks'] || '')
  }));
  (appData.income || []).forEach(r => rows.push({
    Type: 'Income',
    Date: r['Date'],
    Amount: Number(r['Income Amount'] || 0),
    Category: r['Category'] || '',
    Description: r['Description'] || '',
    'Payment Mode': r['Payment Mode'] || '',
    Account: r['Account'] || '',
    Remarks: r['Remarks'] === '-' ? '' : (r['Remarks'] || '')
  }));
  if (!rows.length) { showToast('Nothing to export yet'); return; }

  rows.sort((a, b) => parseSheetDate(b.Date) - parseSheetDate(a.Date));
  const name = `wallet-${(currentUser && currentUser.username) || 'user'}-${todayISO()}.csv`;
  downloadFile(name, toCSV(CSV_HEADERS, rows), 'text/csv;charset=utf-8');
}

function downloadSampleCSV() {
  const sample = [
    { Type:'Expense', Date:'01/08/2026', Amount:450, Category:'Food',
      Description:'Lunch with team', 'Payment Mode':'UPI', Account:'', Remarks:'' },
    { Type:'Expense', Date:'03/08/2026', Amount:1200, Category:'Groceries',
      Description:'Weekly shop', 'Payment Mode':'Card', Account:'', Remarks:'Big basket' },
    { Type:'Income',  Date:'05/08/2026', Amount:50000, Category:'Salary',
      Description:'August salary', 'Payment Mode':'Net Banking', Account:'', Remarks:'' }
  ];
  downloadFile('wallet-sample.csv', toCSV(CSV_HEADERS, sample), 'text/csv;charset=utf-8');
  
}

// ── Import ──
let _importPayload = null;
let _importMode = 'merge';

function openImport() {
  _importPayload = null;
  _importMode = 'merge';
  document.getElementById('import-file').value = '';
  document.getElementById('import-summary').style.display = 'none';
  document.getElementById('import-go').style.display = 'none';
  document.getElementById('import-pass-row').style.display = 'none';
  document.querySelectorAll('#import-overlay .opt-row').forEach((el, i) =>
    el.classList.toggle('active', i === 0));
  document.getElementById('import-overlay').classList.add('open');
}

function setImportMode(mode, el) {
  _importMode = mode;
  document.querySelectorAll('#import-overlay .opt-row').forEach(r => r.classList.remove('active'));
  el.classList.add('active');

}

// Accepts DD/MM/YYYY, YYYY-MM-DD or DD-MM-YYYY and normalises to DD/MM/YYYY
function normaliseDate(v) {
  const t = String(v || '').trim();
  let m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/.exec(t);
  if (m) return `${m[1].padStart(2,'0')}/${m[2].padStart(2,'0')}/${m[3]}`;
  m = /^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/.exec(t);
  if (m) return `${m[3].padStart(2,'0')}/${m[2].padStart(2,'0')}/${m[1]}`;
  return null;
}

function handleImportFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const rows = parseCSV(reader.result);
      if (rows.length < 2) throw new Error('empty');

      // Match headers case-insensitively so Excel edits don't break it
      const head = rows[0].map(h => h.trim().toLowerCase());
      const col = name => head.indexOf(name.toLowerCase());
      const iType = col('Type'), iDate = col('Date'), iAmt = col('Amount');
      if (iType < 0 || iDate < 0 || iAmt < 0) {
        showToast('CSV needs at least Type, Date and Amount columns');
        return;
      }
      const iCat = col('Category'), iDesc = col('Description'),
            iPM = col('Payment Mode'), iAcct = col('Account'), iRem = col('Remarks');
      const get = (r, i) => (i >= 0 && r[i] != null ? String(r[i]).trim() : '');

      const expenses = [], income = [];
      const errors = [];
      rows.slice(1).forEach((r, n) => {
        const line = n + 2;
        const type = get(r, iType).toLowerCase();
        const date = normaliseDate(get(r, iDate));
        const amt  = Number(String(get(r, iAmt)).replace(/[₹,\s]/g, ''));
        if (!type)              { errors.push(`Line ${line}: missing Type`); return; }
        if (!/^(expense|income)$/.test(type)) { errors.push(`Line ${line}: Type must be Expense or Income`); return; }
        if (!date)              { errors.push(`Line ${line}: bad date "${get(r, iDate)}"`); return; }
        if (!amt || isNaN(amt)) { errors.push(`Line ${line}: bad amount "${get(r, iAmt)}"`); return; }

        const base = {
          Date: date,
          Category: get(r, iCat) || (type === 'income' ? 'Other' : 'Miscellaneous'),
          Description: get(r, iDesc) || '-',
          'Payment Mode': get(r, iPM) || 'UPI',
          Account: get(r, iAcct) || null,
          Remarks: get(r, iRem) || '-'
        };
        if (type === 'expense') expenses.push({ ...base, 'Expense Amount': amt });
        else                    income.push({ ...base, 'Income Amount': amt });
      });

      if (!expenses.length && !income.length) {
        showToast('No valid rows found in that file');
        return;
      }
      _importPayload = { expenses, income };

      const el = document.getElementById('import-summary');
      el.style.display = 'block';
      el.innerHTML = `<div class="imp-title">Ready to import</div>` +
        (expenses.length ? `<div class="imp-line"><span>Expenses</span><b>${expenses.length}</b></div>` : '') +
        (income.length   ? `<div class="imp-line"><span>Income</span><b>${income.length}</b></div>` : '') +
        (errors.length
          ? `<div class="imp-errors"><b>${errors.length} row${errors.length>1?'s':''} skipped</b>` +
            errors.slice(0, 5).map(e => `<div>${esc(e)}</div>`).join('') +
            (errors.length > 5 ? `<div>…and ${errors.length - 5} more</div>` : '') + `</div>`
          : '');
      document.getElementById('import-go').style.display = 'flex';

    } catch(e) {
      _importPayload = null;
      showToast('Could not read that CSV');
    }
  };
  reader.onerror = () => showToast('Could not read that file');
  reader.readAsText(file);
}

async function runImport() {
  if (!_importPayload) { showToast('Choose a CSV file first'); return; }
  const go = () => doImport();
  if (_importMode === 'replace') {
    showConfirm('Replace all existing data with this file?\n\nEverything currently in your account will be deleted first. This cannot be undone.',
      go, 'Replace');
  } else { go(); }
}

async function doImport() {
  const btn = document.getElementById('import-go');
  btn.textContent = 'Importing...'; btn.disabled = true;
  try {
    const res = await apiPost({
      action: 'importData',
      mode: _importMode,
      confirm: _importMode === 'replace' ? 'REPLACE' : '',
      payload: _importPayload
    });
    if (res.success) {
      closeOverlay('import-overlay');
      clearCache();
      await refreshFromAPI();
      const n = Object.values(res.counts || {}).reduce((a, b) => a + b, 0);
      showToast(`Imported ${n} transactions`);   // a real summary, not a confirmation
    } else {
      showToast(res.error || 'Import failed');
    }
  } catch(e) {
    showToast('Import failed — ' + e.message);
  }
  btn.textContent = 'Import'; btn.disabled = false;
}

// ── Delete the whole account ──
function openDeleteAccount() {
  closeSettings();
  document.getElementById('del-pass').value = '';
  document.getElementById('del-confirm').value = '';
  authError('del-err', '');
  document.getElementById('delacct-overlay').classList.add('open');
}

async function runDeleteAccount() {
  const pass    = document.getElementById('del-pass').value;
  const confirm = document.getElementById('del-confirm').value.trim().toUpperCase();
  authError('del-err', '');

  if (!pass)                          { authError('del-err', 'Enter your password'); return; }
  if (confirm !== 'DELETE MY ACCOUNT'){ authError('del-err', 'Type DELETE MY ACCOUNT exactly'); return; }

  const btn = document.getElementById('del-btn');
  btn.textContent = 'Checking…'; btn.disabled = true;
  try {
    await ensureSupabase();

    // Re-authenticate first. Deleting everything off the back of a session that
    // might have been left open on a shared device isn't good enough.
    const { error: pwErr } = await sb.auth.signInWithPassword({
      email: currentUser.email, password: pass,
    });
    if (pwErr) { authError('del-err', 'That password is not correct'); throw new Error('bad password'); }

    btn.textContent = 'Deleting…';
    const res = await apiPost({ action: 'deleteMyAccount', confirm: 'DELETE MY ACCOUNT' });
    if (!res.success) { authError('del-err', res.error || 'Could not delete the account'); throw new Error(res.error); }

    // Nothing left to come back to — clear every local trace as well
    try {
      accounts.forEach(a => clearCacheFor(a.id));
      localStorage.removeItem(ACCOUNTS_KEY);
      localStorage.removeItem(SESSIONS_KEY);
      localStorage.removeItem(LAST_USER_KEY);
      localStorage.removeItem(prefsKey());
      localStorage.removeItem(NOTIF_READ_KEY);
    } catch(e) {}
    accounts = [];
    closeOverlay('delacct-overlay');
    await signOut();

  } catch(e) {
    // the specific message is already on screen
  }
  btn.textContent = 'Delete my account forever'; btn.disabled = false;
}

// ── Clear everything ──
function openClearData() {
  document.getElementById('clear-pass').value = '';
  document.getElementById('clear-confirm').value = '';
  document.getElementById('clear-overlay').classList.add('open');
}

async function runClearData() {
  const confirm = document.getElementById('clear-confirm').value.trim().toUpperCase();
  if (confirm !== 'DELETE') { showToast('Type DELETE to confirm'); return; }

  showConfirm(
    'Delete every transaction, loan, EMI and account?\n\nThis wipes your data from the server and cannot be undone. Export a backup first if you might want it back.',
    async () => {
      const btn = document.getElementById('clear-go');
      btn.textContent = 'Deleting...'; btn.disabled = true;
      try {
        const res = await apiPost({ action: 'clearData', confirm: 'DELETE' });
        if (res.success) {
          closeOverlay('clear-overlay');
          clearCache();
          await refreshFromAPI();

        } else { showToast(res.error || 'Could not delete'); }
      } catch(e) { showToast('Failed — ' + e.message); }
      btn.textContent = 'Delete everything'; btn.disabled = false;
    }, 'Delete');
}

// ══════════════════════════════════════════════════════════════
// PROFILE
// ══════════════════════════════════════════════════════════════
function renderProfilePage() {
  const u = currentUser || {};
  const initial = (u.firstName || u.username || u.email || '?').charAt(0).toUpperCase();
  document.getElementById('profile-avatar').textContent = initial;
  document.getElementById('profile-name').textContent =
    u.fullName || u.username || 'You';
  document.getElementById('profile-email').textContent = u.email || '';
  document.getElementById('pf-first').value  = u.firstName || '';
  document.getElementById('pf-last').value   = u.lastName || '';
  document.getElementById('pf-mobile').value = u.mobile || '';
  document.getElementById('pf-email').value  = u.email || '';
  document.getElementById('pf-pass').value   = '';
}

async function saveProfile() {
  const firstName = document.getElementById('pf-first').value.trim();
  const lastName  = document.getElementById('pf-last').value.trim();
  const mobile    = document.getElementById('pf-mobile').value.trim();
  if (!firstName) { showToast('First name is required'); return; }
  if (mobile && !/^[+\d][\d\s\-()]{5,19}$/.test(mobile)) {
    showToast("That mobile number doesn't look right"); return;
  }

  const btn = document.getElementById('pf-save-btn');
  btn.textContent = 'Saving…'; btn.disabled = true;
  try {
    const res = await apiPost({ action: 'updateProfile', firstName, lastName, mobile });
    if (res.success) {
      Object.assign(currentUser, {
        firstName: res.profile.firstName,
        lastName: res.profile.lastName,
        fullName: res.profile.fullName,
        mobile: res.profile.mobile,
        username: res.profile.firstName || currentUser.username,
      });
      upsertAccount(currentUser);
      initMainScreen();
      renderProfilePage();
      renderSettings();
      
    } else { showToast(res.error || 'Could not save'); }
  } catch(e) { showToast('Could not save — ' + e.message); }
  btn.textContent = 'Save details'; btn.disabled = false;
}

async function changePassword() {
  const pass = document.getElementById('pf-pass').value;
  if (pass.length < 8) { showToast('Passwords need at least 8 characters'); return; }
  const btn = document.getElementById('pf-pass-btn');
  btn.textContent = 'Updating…'; btn.disabled = true;
  try {
    await ensureSupabase();
    const { error } = await sb.auth.updateUser({ password: pass });
    if (error) throw error;
    document.getElementById('pf-pass').value = '';
    showToast('Password changed');
  } catch(e) { showToast(friendlyAuthError(e)); }
  btn.textContent = 'Change password'; btn.disabled = false;
}

// ══════════════════════════════════════════════════════════════
// PREFERENCES
// ══════════════════════════════════════════════════════════════
// Preferences are stored per user, not per device, so switching accounts no
// longer inherits the previous person's budget or theme. localStorage is the
// fast local copy; the server row is the source of truth across devices.
const PREFS_KEY_BASE = 'wallet_prefs_v1';
const DEFAULT_PREFS = {
  theme: 'light', accent: '#1a73e8',
  hideBalance: true, decimals: false, haptics: true,
  carryForward: false,
  budget: 0, catBudgets: {},
  defaultAccount: ''
};
let prefs = { ...DEFAULT_PREFS };
let _prefsLoadedFor = null;

function prefsKey() {
  return PREFS_KEY_BASE + (currentUser ? ':' + currentUser.id : '');
}

function loadPrefs() {
  prefs = { ...DEFAULT_PREFS };
  try {
    // Fall back to the old device-wide blob once, so nobody loses their setup
    const raw = localStorage.getItem(prefsKey()) || localStorage.getItem(PREFS_KEY_BASE);
    if (raw) Object.assign(prefs, JSON.parse(raw) || {});
  } catch(e) {}
  // Themes used to live in their own keys
  try {
    const t = localStorage.getItem('wallet_theme');
    const a = localStorage.getItem('wallet_accent');
    if (t && !prefs.theme)  prefs.theme = t;
    if (a && !prefs.accent) prefs.accent = a;
  } catch(e) {}
  _prefsLoadedFor = currentUser ? currentUser.id : null;
}

// Merge whatever the server has on top of the local copy, then apply it
function applyServerSettings(remote, forUserId) {
  if (!remote || typeof remote !== 'object') return;
  // A slow response could arrive after the user switched accounts — ignore it
  if (forUserId && currentUser && String(forUserId) !== String(currentUser.id)) return;
  const before = JSON.stringify(prefs);
  Object.assign(prefs, remote);
  writePrefsLocal();
  if (JSON.stringify(prefs) === before) return;
  applyPrefsToUI(true);
}

// Everything a preference change can affect on screen, in one place. Called
// on login, on every account switch, and when the server sends newer values.
function applyPrefsToUI(rerender) {
  if (typeof applyTheme === 'function') applyTheme(prefs.theme || 'light', true);
  if (typeof setAccent  === 'function' && prefs.accent) setAccent(prefs.accent, true);
  balanceHidden = prefs.hideBalance;
  updateEyeIcon();
  if (rerender) {
    renderAll();                       // decimals + carry-forward change every figure
    if (_settingsOpen) renderSettings();
  }
}

// Loads the signed-in user's preferences and puts them on screen
function loadPrefsFor() {
  loadPrefs();
  applyPrefsToUI(false);
}

function writePrefsLocal() {
  try { localStorage.setItem(prefsKey(), JSON.stringify(prefs)); } catch(e) {}
}

// Writes locally at once, pushes to the server on a short debounce so dragging
// a colour picker doesn't fire a request per frame.
let _syncTimer = null;
function persistPrefs() {
  writePrefsLocal();
  if (!currentUser) return;
  clearTimeout(_syncTimer);
  // Capture who and what now — a switch before the timer fires must not save
  // this account's preferences onto the next one.
  const owner = currentUser.id;
  const snapshot = JSON.parse(JSON.stringify(prefs));
  _syncTimer = setTimeout(() => pushSettings(owner, snapshot), 700);
}

async function pushSettings(userId, settings) {
  if (!userId) return;
  try {
    const res = await apiPost({ action: 'saveSettings', userId, settings });
    if (!res.success && res.error && /migration/i.test(res.error)) {
      console.warn('Settings sync unavailable:', res.error);
    }
  } catch(e) {
    console.warn('Settings sync failed, kept locally:', e.message);
  }
}

function setPref(key, val) {
  prefs[key] = !!val;
  persistPrefs();
  if (key === 'hideBalance') { balanceHidden = !!val; updateEyeIcon(); }
  if (key === 'decimals' || key === 'carryForward') renderAll();
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
  // configState is the live truth — it's rebuilt from the server on load and
  // updated the moment a category is toggled. Reading appData.config directly
  // meant a category switched off still appeared until the next full refresh.
  const key = ['expense','income','loan','emi'].includes(type) ? type : 'expense';
  const defaults = CAT_DEFAULTS[key]();
  const st = configState[key];
  return [...defaults.filter(c => st.checked.has(c)), ...st.custom];
}

// ── POPULATE ALL CATEGORY SELECTS ──
// The add screen builds its own pickers now; this only refreshes the edit form.
function populateCategorySelects() {}


// ── RENDER DASHBOARD ──
function renderDashboard() {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const to   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23,59,59,999).getTime();

  // Previous month, for the little delta chips
  const pFrom = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
  const pTo   = new Date(now.getFullYear(), now.getMonth(), 0, 23,59,59,999).getTime();

  const inRange = (r, a, b) => { const ts = parseSheetDate(r['Date']); return ts >= a && ts <= b; };
  const acct = r => {
    if (!anaAccount) return true;
    const a = String(r['Account'] || '').trim();
    return anaAccount === UNASSIGNED ? !a : a === anaAccount;
  };

  const expenses = appData.expenses.filter(r => acct(r) && inRange(r, from, to));
  const income   = appData.income.filter(r   => acct(r) && inRange(r, from, to));
  const pExp = appData.expenses.filter(r => acct(r) && inRange(r, pFrom, pTo))
    .reduce((s, r) => s + Number(r['Expense Amount'] || 0), 0);
  const pInc = appData.income.filter(r => acct(r) && inRange(r, pFrom, pTo))
    .reduce((s, r) => s + Number(r['Income Amount'] || 0), 0);

  const totalExp = expenses.reduce((s, r) => s + Number(r['Expense Amount'] || 0), 0);
  const totalInc = income.reduce((s, r)   => s + Number(r['Income Amount']   || 0), 0);

  // Carry forward ON  → a running balance: whatever was left over last month
  //                      rolls into this one, plus any account opening balance.
  // Carry forward OFF → each month stands alone and starts from zero.
  let balance, balanceLabel;
  if (prefs.carryForward) {
    const allExp = appData.expenses.filter(acct).reduce((s,r) => s + Number(r['Expense Amount']||0), 0);
    const allInc = appData.income.filter(acct).reduce((s,r) => s + Number(r['Income Amount']||0), 0);
    const opening = !anaAccount
      ? accountsList().reduce((s,a) => s + Number(a.opening||0), 0)
      : anaAccount === UNASSIGNED ? 0
      : Number((accountsList().find(a => a.name === anaAccount) || {}).opening || 0);
    balance = opening + allInc - allExp;
    balanceLabel = 'Total Balance';
  } else {
    balance = totalInc - totalExp;
    balanceLabel = 'Balance this month';
  }
  const lblEl = document.getElementById('bc-label');
  if (lblEl) lblEl.textContent = balanceLabel;

  const loanSummary = appData.loanSummary || [];
  const toReceive = loanSummary.filter(l => /lent/i.test(l.type)).reduce((s, l) => s + Number(l.pending || 0), 0);
  const toOwe     = loanSummary.filter(l => /borrow/i.test(l.type)).reduce((s, l) => s + Number(l.pending || 0), 0);

  document.getElementById('dash-balance').innerHTML  = fmtBalance(balance);
  document.getElementById('dash-income').textContent  = fmtMini(totalInc);
  document.getElementById('dash-expense').textContent = fmtMini(totalExp);
  document.getElementById('dash-receive').textContent = fmt(toReceive);
  document.getElementById('dash-owe').textContent     = fmt(toOwe);
  document.getElementById('bc-account').textContent   = accountChipLabel();
  setDelta('inc-delta', totalInc, pInc, true);
  setDelta('exp-delta', totalExp, pExp, false);
  updateEyeIcon();

  renderHeader();
  refreshNotifications();
  requestAnimationFrame(fitDashboardText);

  const allTxns = [
    ...expenses.map((r, i) => ({ ...r, _type: 'expense', _amt: Number(r['Expense Amount'] || 0), _date: r['Date'], _cat: r['Category'], _desc: r['Description'], _pm: r['Payment Mode'], _rowIndex: r._rowIndex, _sortKey: sortKey(r, i) })),
    ...income.map((r, i)   => ({ ...r, _type: 'income',  _amt: Number(r['Income Amount']   || 0), _date: r['Date'], _cat: r['Category'], _desc: r['Description'], _pm: r['Payment Mode'], _rowIndex: r._rowIndex, _sortKey: sortKey(r, i) }))
  ].sort((a, b) => b._sortKey - a._sortKey).slice(0, 8);

  const recentEl = document.getElementById('dash-recent');
  recentEl.innerHTML = allTxns.length
    ? allTxns.map(r => entryItemHTML(r)).join('')
    : emptyState('No transactions', 'Add your first entry using the + button');
}

// Header sits above every page now, so it renders independently of the dashboard
function renderHeader() {
  const greet = document.getElementById('hh-greet');
  if (greet && currentUser) greet.textContent = 'Hi, ' + currentUser.username + '!';
  const dateEl = document.getElementById('hh-date');
  if (dateEl) {
    const now = new Date();
    const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const months = ['January','February','March','April','May','June','July',
                    'August','September','October','November','December'];
    dateEl.textContent = `${days[now.getDay()]}, ${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()}`;
  }
}

// Small ↗5.2% chip next to the monthly figures. `goodUp` flips the colour so a
// rise in spending reads as bad while a rise in income reads as good.
function setDelta(id, current, previous, goodUp) {
  const el = document.getElementById(id);
  if (!el) return;
  if (balanceHidden || !previous) { el.innerHTML = ''; return; }
  const change = (current - previous) / Math.abs(previous) * 100;
  if (!isFinite(change)) { el.innerHTML = ''; return; }
  const up = change >= 0;
  const good = goodUp ? up : !up;
  const arrow = up
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="9 7 17 7 17 15"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2"><line x1="7" y1="7" x2="17" y2="17"/><polyline points="17 9 17 17 9 17"/></svg>';
  el.className = 'bc-delta ' + (good ? 'good' : 'bad');
  el.innerHTML = `${arrow}${Math.abs(change).toFixed(1)}%`;
}

// ══════════════════════════════════════════════════════════════
// BUDGET — an overall monthly limit plus per-category limits
// Stored locally in prefs: { budget: number, catBudgets: { [name]: number } }
// ══════════════════════════════════════════════════════════════
function monthSpend() {
  const now = new Date();
  const f = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const t = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23,59,59,999).getTime();
  return appData.expenses.filter(r => {
    const ts = parseSheetDate(r['Date']);
    return ts >= f && ts <= t;
  });
}

function catSpendMap() {
  const map = {};
  monthSpend().forEach(r => {
    const c = r['Category'] || 'Uncategorised';
    map[c] = (map[c] || 0) + Number(r['Expense Amount'] || 0);
  });
  return map;
}

function renderBudgetPage() {
  const rows  = monthSpend();
  const spent = rows.reduce((s, r) => s + Number(r['Expense Amount'] || 0), 0);
  const budget = Number(prefs.budget || 0);

  document.getElementById('bg-spent').textContent = fmt(spent);
  const fill = document.getElementById('bg-hero-fill');
  const left = document.getElementById('bg-hero-left');
  if (budget) {
    const pct = Math.round(spent / budget * 100);
    fill.style.width = Math.min(100, pct) + '%';
    fill.className = 'bg-hero-fill' + (pct >= 100 ? ' over' : pct >= 80 ? ' warn' : '');
    left.innerHTML = pct >= 100
      ? `${fmt(spent - budget)} over your ${fmt(budget)} limit`
      : `${fmt(budget - spent)} left of ${fmt(budget)} · ${pct}%`;
  } else {
    fill.style.width = '0%';
    left.textContent = 'No overall budget set';
  }

  const spendMap = catSpendMap();
  const budgets  = prefs.catBudgets || {};
  const names = [...new Set([...Object.keys(budgets), ...Object.keys(spendMap)])]
    .filter(n => budgets[n])                       // only categories with a limit
    .sort((a, b) => (spendMap[b]||0)/budgets[b] - (spendMap[a]||0)/budgets[a]);

  const el = document.getElementById('cat-budget-list');
  if (!names.length) {
    el.innerHTML = `<div class="hcard"><div class="hcard-empty">
      No category budgets yet — tap <b>+ Add</b> to set one</div></div>`;
    return;
  }
  el.innerHTML = names.map(n => {
    const lim = Number(budgets[n] || 0);
    const sp  = Number(spendMap[n] || 0);
    const pct = lim ? Math.round(sp / lim * 100) : 0;
    const cls = pct >= 100 ? 'over' : pct >= 80 ? 'warn' : '';
    return `<div class="cb-row" onclick="openCatBudgetSheet('${esc(n).replace(/'/g,"\\'")}')">
      <div class="cb-top">
        <div class="cb-left">
          <span class="cb-dot" style="background:${catColor(n)}"></span>
          <span class="cb-name">${esc(n)}</span>
        </div>
        <span class="cb-pct ${cls}">${pct}%</span>
      </div>
      <div class="cb-bar"><div class="cb-fill ${cls}" style="width:${Math.min(100,pct)}%"></div></div>
      <div class="cb-foot"><span>${fmt(sp)} of ${fmt(lim)}</span>
        <span class="${cls}">${sp > lim ? fmt(sp - lim) + ' over' : fmt(lim - sp) + ' left'}</span></div>
    </div>`;
  }).join('');
}

// ── Overall limit ──
function openBudgetSheet() {
  document.getElementById('budget-input').value = prefs.budget || '';
  document.getElementById('budget-overlay').classList.add('open');
}

function saveBudget() {
  const v = document.getElementById('budget-input').value;
  prefs.budget = v ? Math.max(0, Number(v)) : 0;
  persistPrefs();
  closeOverlay('budget-overlay');
  if (currentPage === 'budget') renderBudgetPage();
  refreshNotifications();
}

// ── Per-category limits ──
let _editingCatBudget = null;

function openCatBudgetSheet(cat) {
  _editingCatBudget = cat || null;
  const sel = document.getElementById('cb-cat');
  const cats = getActiveCategories('expense');
  const extra = Object.keys(prefs.catBudgets || {}).filter(c => !cats.includes(c));
  sel.innerHTML = [...cats, ...extra]
    .map(c => `<option value="${esc(c)}" ${c === cat ? 'selected' : ''}>${esc(c)}</option>`).join('');
  sel.disabled = !!cat;
  document.getElementById('cb-sheet-title').textContent = cat ? 'Edit budget' : 'Category budget';
  document.getElementById('cb-amount').value = cat ? (prefs.catBudgets[cat] || '') : '';
  document.getElementById('cb-delete').style.display = cat ? 'flex' : 'none';
  document.getElementById('catbudget-overlay').classList.add('open');
}

function saveCatBudget() {
  const cat = document.getElementById('cb-cat').value;
  const amt = Number(document.getElementById('cb-amount').value || 0);
  if (!cat)  { showToast('Pick a category'); return; }
  if (amt <= 0) { showToast('Enter an amount above zero'); return; }
  prefs.catBudgets = prefs.catBudgets || {};
  prefs.catBudgets[cat] = amt;
  persistPrefs();
  closeOverlay('catbudget-overlay');
  showToast('Budget set for ' + cat);
  renderBudgetPage();
  refreshNotifications();
}

function deleteCatBudget() {
  const cat = _editingCatBudget;
  if (!cat) return;
  showConfirm(`Remove the budget for "${cat}"?`, () => {
    delete prefs.catBudgets[cat];
    persistPrefs();
    closeOverlay('catbudget-overlay');
    renderBudgetPage();
    refreshNotifications();
  }, 'Remove');
}

// EMIs falling due inside a window — feeds the notification list
function upcomingEMIs(days = 45) {
  const today = new Date(); today.setHours(0,0,0,0);
  const limit = today.getTime() + days * 86400000;
  return (appData.emis || [])
    .filter(e => String(e['Status']) !== 'Closed')
    .map(e => {
      const ts = parseSheetDate(e['Next Due Date']);
      return { e, ts, left: Math.round((ts - today.getTime()) / 86400000) };
    })
    .filter(x => x.ts && x.ts <= limit)
    .sort((a, b) => a.ts - b.ts);
}

// ══════════════════════════════════════════════════════════════
// ALL TRANSACTIONS
// Every expense and income, newest first, grouped by day with a running
// per-day total. Searchable and filterable by type.
// ══════════════════════════════════════════════════════════════
let _txnFilter = 'all';
let _txnOpen   = false;

function openAllTransactions() {
  _txnFilter = 'all';
  document.getElementById('txn-q').value = '';
  document.getElementById('txn-clear').style.display = 'none';
  document.querySelectorAll('#txn-chips .txn-chip').forEach((c, i) =>
    c.classList.toggle('active', i === 0));
  renderTxnList();
  document.getElementById('txn-screen').classList.add('open');
  document.body.classList.add('no-scroll');
  _txnOpen = true;
  try { history.pushState({ walletTxn: true }, ''); } catch(e) {}
}

function closeAllTransactions() {
  if (!_txnOpen) return;
  _txnOpen = false;
  document.getElementById('txn-screen').classList.remove('open');
  if (!_settingsOpen && !_notifOpen) document.body.classList.remove('no-scroll');
  try { if (history.state && history.state.walletTxn) history.back(); } catch(e) {}
}

function setTxnFilter(f, el) {
  _txnFilter = f;
  document.querySelectorAll('#txn-chips .txn-chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  renderTxnList();
}

function clearTxnSearch() {
  document.getElementById('txn-q').value = '';
  document.getElementById('txn-clear').style.display = 'none';
  renderTxnList();
}

function allTransactions() {
  const acct = r => {
    if (!anaAccount) return true;
    const a = String(r['Account'] || '').trim();
    return anaAccount === UNASSIGNED ? !a : a === anaAccount;
  };
  const rows = [];
  appData.expenses.filter(acct).forEach((r, i) => rows.push({ ...r,
    _type:'expense', _amt:Number(r['Expense Amount']||0), _date:r['Date'],
    _cat:r['Category'], _desc:r['Description'], _pm:r['Payment Mode'],
    _rowIndex:r._rowIndex, _sortKey:sortKey(r, i) }));
  appData.income.filter(acct).forEach((r, i) => rows.push({ ...r,
    _type:'income', _amt:Number(r['Income Amount']||0), _date:r['Date'],
    _cat:r['Category'], _desc:r['Description'], _pm:r['Payment Mode'],
    _rowIndex:r._rowIndex, _sortKey:sortKey(r, i) }));
  return rows.sort((a, b) => b._sortKey - a._sortKey);
}

// "Today", "Yesterday", then a written date
function dayHeading(ts) {
  const d = new Date(ts);
  const today = new Date(); today.setHours(0,0,0,0);
  const diff = Math.round((today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const mon  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const y = d.getFullYear() === today.getFullYear() ? '' : ' ' + d.getFullYear();
  return `${days[d.getDay()]}, ${d.getDate()} ${mon[d.getMonth()]}${y}`;
}

function renderTxnList() {
  const q = (document.getElementById('txn-q').value || '').trim().toLowerCase();
  document.getElementById('txn-clear').style.display = q ? 'flex' : 'none';

  let rows = allTransactions();
  const total = rows.length;
  if (_txnFilter !== 'all') rows = rows.filter(r => r._type === _txnFilter);
  if (q) {
    rows = rows.filter(r =>
      String(r._cat  || '').toLowerCase().includes(q) ||
      String(r._desc || '').toLowerCase().includes(q) ||
      String(r._pm   || '').toLowerCase().includes(q) ||
      String(r['Account'] || '').toLowerCase().includes(q) ||
      String(Math.round(r._amt)).includes(q));
  }

  document.getElementById('txn-count').textContent =
    total ? `${rows.length} of ${total}` : '';

  const el = document.getElementById('txn-list');
  if (!rows.length) {
    el.innerHTML = emptyState(
      q ? 'Nothing found' : 'No transactions yet',
      q ? 'Try a different search' : 'Add your first entry with the + button');
    return;
  }

  // Group by calendar day, keeping the newest-first order
  const groups = [];
  let cur = null;
  rows.forEach(r => {
    const ts = parseSheetDate(r._date);
    const key = new Date(ts).toDateString();
    if (!cur || cur.key !== key) {
      cur = { key, ts, label: dayHeading(ts), rows: [], net: 0 };
      groups.push(cur);
    }
    cur.rows.push(r);
    cur.net += (r._type === 'income' ? r._amt : -r._amt);
  });

  el.innerHTML = groups.map(g => `
    <div class="txn-day">
      <span>${g.label}</span>
      <span class="txn-day-net ${g.net < 0 ? 'red' : g.net > 0 ? 'green' : ''}">${
        (g.net < 0 ? '-' : g.net > 0 ? '+' : '') + fmt(Math.abs(g.net))}</span>
    </div>
    <div class="txn-group">${g.rows.map(txnRowHTML).join('')}</div>`).join('');
}

function txnRowHTML(r) {
  const inc = r._type === 'income';
  // Same registry the other entry lists use, so tapping opens the normal
  // detail sheet with edit and delete
  const key = (r._type || 'exp') + '_' + (r._rowIndex || Math.random());
  _entryRegistry[key] = r;
  const sub = [r._desc && r._desc !== '-' ? r._desc : '', r._pm]
    .filter(Boolean).join(' · ');
  const arrow = inc
    ? '<polyline points="7 17 17 7"/><polyline points="9 7 17 7 17 15"/>'
    : '<polyline points="7 7 17 17"/><polyline points="17 9 17 17 9 17"/>';
  return `<div class="txn-row" onclick="openEntryDetail('${key}')">
    <div class="txn-icon ${inc ? 'inc' : 'exp'}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">${arrow}</svg>
    </div>
    <div class="txn-info">
      <div class="txn-cat">${esc(String(r._cat || 'Uncategorised'))}</div>
      ${sub ? `<div class="txn-sub">${esc(sub)}</div>` : ''}
    </div>
    <div class="txn-amt ${inc ? 'green' : 'red'}">${inc ? '+' : '-'}${fmt(r._amt)}</div>
  </div>`;
}

// ══════════════════════════════════════════════════════════════
// NOTIFICATIONS
// Derived from the data itself — EMIs falling due, budget pressure and
// outstanding loans. Read state is remembered per notification id.
// ══════════════════════════════════════════════════════════════
const NOTIF_READ_KEY = 'wallet_notif_read_v1';

function readNotifIds() {
  try { return new Set(JSON.parse(localStorage.getItem(NOTIF_READ_KEY) || '[]')); }
  catch(e) { return new Set(); }
}
function saveNotifIds(set) {
  try { localStorage.setItem(NOTIF_READ_KEY, JSON.stringify([...set])); } catch(e) {}
}

function buildNotifications() {
  const out = [];
  const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  upcomingEMIs(7).forEach(({ e, ts, left }) => {
    const d = new Date(ts);
    const id = `emi:${e['EMI ID']}:${d.toISOString().slice(0,10)}`;
    out.push({
      id,
      kind: left < 0 ? 'danger' : 'warn',
      icon: 'calendar',
      title: left < 0 ? 'EMI overdue' : left === 0 ? 'EMI due today' : `EMI due in ${left} day${left>1?'s':''}`,
      body: `${String(e['Description'] || e['Category'] || 'EMI')} · ${fmt(Number(e['EMI Amount']||0))} on ${d.getDate()} ${MON[d.getMonth()]}`,
      action: () => switchPage('emis')
    });
  });

  const budget = Number(prefs.budget || 0);
  if (budget) {
    const now = new Date();
    const f = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const t = new Date(now.getFullYear(), now.getMonth()+1, 0, 23,59,59,999).getTime();
    const spent = appData.expenses
      .filter(r => { const ts = parseSheetDate(r['Date']); return ts >= f && ts <= t; })
      .reduce((s,r) => s + Number(r['Expense Amount']||0), 0);
    const pct = Math.round(spent / budget * 100);
    const tag = `${now.getFullYear()}-${now.getMonth()}`;
    if (pct >= 100) {
      out.push({ id:`budget:over:${tag}`, kind:'danger', icon:'alert',
        title:'Budget exceeded',
        body:`You've spent ${fmt(spent)} of your ${fmt(budget)} budget.`,
        action: openBudgetSheet });
    } else if (pct >= 80) {
      out.push({ id:`budget:80:${tag}`, kind:'warn', icon:'alert',
        title:'Budget alert',
        body:`You've spent ${pct}% of your monthly budget.`,
        action: openBudgetSheet });
    }
  }

  const cb = prefs.catBudgets || {};
  const spendMap = catSpendMap();
  const tagM = `${new Date().getFullYear()}-${new Date().getMonth()}`;
  Object.keys(cb).forEach(c => {
    const lim = Number(cb[c] || 0);
    const sp  = Number(spendMap[c] || 0);
    if (!lim || sp < lim) return;
    out.push({ id:`catbudget:${c}:${tagM}`, kind:'danger', icon:'alert',
      title:`${c} budget exceeded`,
      body:`${fmt(sp)} spent against a ${fmt(lim)} limit.`,
      action: () => switchPage('budget') });
  });

  const ls = appData.loanSummary || [];
  const owe = ls.filter(l => /borrow/i.test(l.type)).reduce((s,l) => s + Number(l.pending||0), 0);
  if (owe > 0) {
    out.push({ id:`loans:owe:${Math.round(owe)}`, kind:'info', icon:'users',
      title:'Money to pay back',
      body:`${fmt(owe)} still outstanding across your borrowings.`,
      action: () => switchPage('loans') });
  }
  const recv = ls.filter(l => /lent/i.test(l.type)).reduce((s,l) => s + Number(l.pending||0), 0);
  if (recv > 0) {
    out.push({ id:`loans:recv:${Math.round(recv)}`, kind:'info', icon:'users',
      title:'Money to receive',
      body:`${fmt(recv)} still owed to you.`,
      action: () => switchPage('loans') });
  }
  return out;
}

let _notifCache = [];
let _notifOpen  = false;

function refreshNotifications() {
  _notifCache = buildNotifications();
  const read = readNotifIds();
  const unread = _notifCache.filter(n => !read.has(n.id)).length;
  const dot = document.getElementById('notif-dot');
  if (dot) dot.style.display = unread ? 'block' : 'none';
}

const NOTIF_ICONS = {
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>'
};

function openNotifications() {
  refreshNotifications();
  renderNotifList();
  document.getElementById('notif-screen').classList.add('open');
  document.body.classList.add('no-scroll');
  _notifOpen = true;
  try { history.pushState({ walletNotif: true }, ''); } catch(e) {}
}

function renderNotifList() {
  const read = readNotifIds();
  const el = document.getElementById('notif-list');
  if (!_notifCache.length) {
    el.innerHTML = `<div class="notif-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
      <div>You're all caught up</div>
      <span>EMI reminders and budget alerts will show up here</span>
    </div>`;
  } else {
    el.innerHTML = _notifCache.map((n, i) =>
      `<div class="notif-row ${read.has(n.id) ? '' : 'unread'}" onclick="tapNotification(${i})">
        <div class="notif-icon ${n.kind}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${NOTIF_ICONS[n.icon] || ''}</svg>
        </div>
        <div class="notif-body">
          <div class="notif-title">${esc(n.title)}</div>
          <div class="notif-text">${esc(n.body)}</div>
        </div>
      </div>`).join('');
  }
}

function closeNotifications() {
  if (!_notifOpen) return;
  _notifOpen = false;
  document.getElementById('notif-screen').classList.remove('open');
  document.body.classList.remove('no-scroll');
  try { if (history.state && history.state.walletNotif) history.back(); } catch(e) {}
}

function tapNotification(i) {
  const n = _notifCache[i];
  if (!n) return;
  const read = readNotifIds();
  read.add(n.id);
  saveNotifIds(read);
  closeNotifications();
  refreshNotifications();
  if (n.action) n.action();
}

function markNotificationsRead() {
  const read = readNotifIds();
  _notifCache.forEach(n => read.add(n.id));
  saveNotifIds(read);
  refreshNotifications();
  renderNotifList();          // repaint in place — don't push another history entry
  
}

// ── MONTH FILTER CHIPS ──
// The Summary page rebuilds its own chips on every render, so this just
// refreshes whichever type is currently showing.
function buildMonthChips() { renderSummary(); }

// The dashboard is pinned to the current month — Summary and Analytics are
// where period switching lives now.
function buildDashMonthChips() {}


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
      if (anaAccount) {
        const acct = String(r['Account'] || '').trim();
        if (anaAccount === UNASSIGNED ? acct : acct !== anaAccount) return false;
      }
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

  const periodEl = document.getElementById('summary-period');
  periodEl.textContent = selected ? selected.cat : summaryPeriodLabel();
  document.getElementById('summary-period-btn').classList.toggle('is-cat', !!selected);

  document.getElementById('chip-type').textContent   = isExp ? 'Expenses' : 'Income';
  document.getElementById('chip-period').textContent = PERIOD_OPTS.find(p => p.id === summaryPeriod).label;
  document.getElementById('chip-cats').textContent   =
    !summaryCats ? 'All categories'
    : summaryCats.size === 1 ? [...summaryCats][0]
    : `${summaryCats.size} categories`;
  const sumAcctChip = document.getElementById('chip-sum-account');
  if (sumAcctChip) sumAcctChip.textContent = accountChipLabel();

  drawDonut(groups, total);
  requestAnimationFrame(fitSummaryText);

  const el = document.getElementById('summary-breakdown');
  if (!groups.length) {
    el.innerHTML = emptyState(isExp ? 'No expenses' : 'No income', 'Nothing recorded for this period');
    return;
  }
  // One card holding every row, divided by hairlines
  el.innerHTML = `<div class="sum-list">` + groups.map((g, i) => {
    const on = summarySel === g.cat;
    const long = fmt(g.amt).length > 12;      // e.g. ₹20,00,00,000 and beyond
    return `<div class="sum-row ${on ? 'sel' : ''} ${summarySel && !on ? 'dim' : ''} ${long ? 'long' : ''}"
        style="animation-delay:${Math.min(i,8) * 35}ms"
        onclick="tapCategory('${esc(g.cat).replace(/'/g,"\\'")}')">
      <div class="sum-icon" style="border-color:${catColor(g.cat)};color:${catColor(g.cat)}">
        ${esc(g.cat.charAt(0).toUpperCase())}
      </div>
      <div class="sum-name">${esc(g.cat)}</div>
      <div class="sum-count">${g.count}</div>
      <div class="sum-amt">${fmt(g.amt)}</div>
      <div class="sum-pct">${pctLabel(g.amt, total)}</div>
    </div>`;
  }).join('') + `</div>`;
}

// 50% rather than 50.0%, but 52.63% keeps its precision
function pctLabel(amt, total) {
  if (!total) return '0%';
  const v = amt / total * 100;
  return (Math.round(v * 100) / 100) + '%';
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
  const R = 88, CX = 100, CY = 100, C = 2 * Math.PI * R;
  const W = 9;                    // thin band, matching the reference proportions

  if (!total || !groups.length) {
    svg.innerHTML = `<circle cx="${CX}" cy="${CY}" r="${R}" fill="none"
      stroke="var(--border)" stroke-width="${W}"/>`;
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
  const GAP  = n > 1 ? Math.max(3, 9 - n * 0.6) : 0;    // tighter gaps as slices multiply
  const MINL = 4;                                        // never let a slice vanish
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
      stroke="${color}" stroke-width="${summarySel === g.cat ? W + 4 : W}" stroke-linecap="round"
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
// Entries with no account set fall into this bucket. The stored value stays
// empty — this is only what the user sees.
const UNASSIGNED_LABEL = 'Main account';

function accountsList() { return appData.accounts || []; }

// Applies the saved default account the first time data lands. Skipped once the
// user has picked something themselves, so a manual "All accounts" sticks.
let _defaultAccountApplied = false;
function applyDefaultAccount() {
  if (_defaultAccountApplied) return;
  const name = prefs.defaultAccount;
  if (!name) { _defaultAccountApplied = true; return; }
  if (!accountsList().some(a => a.name === name)) return;   // wait for accounts to load
  anaAccount = name;
  _defaultAccountApplied = true;
}
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
    .concat([{ id:UNASSIGNED, label:UNASSIGNED_LABEL }]);
  document.getElementById('anaacct-opts').innerHTML = opts
    .map(o => optRow(o, (anaAccount || '') === o.id, `setAnaAccount('${esc(o.id).replace(/'/g,"\\'")}')`))
    .join('');
  document.getElementById('anaacct-overlay').classList.add('open');
}

function setAnaAccount(id) {
  _defaultAccountApplied = true;   // an explicit choice wins over the default
  anaAccount = id || null;
  summarySel = null;
  renderDashboard();
  renderSummary();
  renderAnalytics();
  closeOverlay('anaacct-overlay');
}

// Label used by both account chips
function accountChipLabel() {
  if (!anaAccount) return 'All accounts';
  if (anaAccount === UNASSIGNED) return UNASSIGNED_LABEL;
  return anaAccount;
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
        <div class="settings-row-label">${esc(a.name)}${
          prefs.defaultAccount === a.name ? '<span class="acct-default">Default</span>' : ''}
          <span class="settings-row-hint">Opening ${fmt(a.opening)}</span></div>
        <div class="settings-row-value" style="color:${bal < 0 ? 'var(--red)' : 'var(--green)'}">${fmt(bal)}</div>
        <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
      </div>`;
    }).join('');
  }
  const total = document.getElementById('bank-total');
  if (list.length) {
    // Sum of the accounts themselves — unassigned transactions are excluded
    const t = list.reduce((s, a) => s + accountBalance(a.name), 0);
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
  document.getElementById('bank-default').checked = !accountsList().length;  // first one defaults
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
  document.getElementById('bank-default').checked = prefs.defaultAccount === a.name;
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
      ? await api({ action:'editAccount', userId: currentUser.id,
                    rowId: editingAccount.rowId, name, opening: opening || 0 })
      : await api({ action:'addAccount',  userId: currentUser.id,
                    name, opening: opening || 0 });
    if (res.success) {
      const makeDefault = document.getElementById('bank-default').checked;
      if (makeDefault) {
        prefs.defaultAccount = name;
        anaAccount = name;
      } else if (prefs.defaultAccount === (editingAccount ? editingAccount.name : name)) {
        prefs.defaultAccount = '';       // default was switched off
        if (anaAccount === name) anaAccount = null;
      }
      persistPrefs();
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
      const res = await api({ action:'deleteAccount', userId: currentUser.id, rowId: a.rowId });
      if (res.success) {
        if (prefs.defaultAccount === a.name) { prefs.defaultAccount = ''; persistPrefs(); }
        if (anaAccount === a.name) anaAccount = null;
        
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
  ['chip-ana-account','chip-sum-account'].forEach(id => {
    const chip = document.getElementById(id);
    if (chip) chip.parentElement.style.display = list.length ? 'flex' : 'none';
  });
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
let anaAccount  = null;               // null = all accounts (shared by Summary + Analytics)

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

  document.getElementById('chip-ana-account').textContent = accountChipLabel();
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
