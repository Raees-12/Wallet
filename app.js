const API_URL = 'https://script.google.com/macros/s/AKfycbxfk1cz75FS5hAiMWknmRmCIyGzh2cEqeJHoTzS6n8m-9zWd4ixHcAD4Wfk4cAyrUtv/exec';
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
let dashFilterRange = { from: null, to: null };
// Default filter = current month (YYYY-MM format)
const _now = new Date();
const _curMonth = `${_now.getFullYear()}-${String(_now.getMonth()+1).padStart(2,'0')}`;
let expFilterVal = _curMonth;
let incFilterVal = _curMonth;
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

function fmt(n) { return '₹' + Number(n).toLocaleString('en-IN'); }

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
function saveSession(u) { try{localStorage.setItem('wallet_user',JSON.stringify(u));}catch(e){} }
function loadSession() { try{return JSON.parse(localStorage.getItem('wallet_user'));}catch(e){return null;} }
function clearSession() { try{localStorage.removeItem('wallet_user');}catch(e){} }
function saveTheme(t) { try{localStorage.setItem('wallet_theme',t);}catch(e){} }
function loadTheme() { try{return localStorage.getItem('wallet_theme')||'light';}catch(e){return 'light';} }

// ── INIT ──
document.addEventListener('DOMContentLoaded', () => {
  try { balanceHidden = localStorage.getItem('wallet_bal_hidden') !== '0'; } catch(e) {}
  const theme = loadTheme();
  applyTheme(theme);
  updateEyeIcon();
  const saved = loadSession();
  if (saved) {
    currentUser = saved;
    initMainScreen();
    showScreen('main-screen');
    loadAllData();
  }
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
      currentUser = res.user;
      saveSession(currentUser);
      initMainScreen();
      showScreen('main-screen');
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
  document.getElementById('profile-avatar-big').textContent = u.username[0].toUpperCase();
  document.getElementById('profile-name').textContent = u.username;
  document.getElementById('profile-email').textContent = u.email||'';
}

function doLogout() {
  closeOverlay('profile-overlay');
  clearSession();
  currentUser = null;
  appData = {expenses:[],income:[],loans:[],loanSummary:[],config:{expense:[],income:[],loan:[]}};
  document.getElementById('login-user').value = '';
  document.getElementById('login-pass').value = '';
  document.getElementById('login-err').textContent = '';
  showScreen('login-screen');
}

// ── API ──
async function api(params) {
  const url = new URL(API_URL);
  Object.entries(params).forEach(([k,v]) => url.searchParams.set(k,v));
  const res = await fetch(url.toString());
  return res.json();
}

// ── LOAD DATA ──
async function loadAllData() {
  document.getElementById('dash-recent').innerHTML = '<div class="loading-wrap"><div class="spinner"></div><div class="loading-text">Loading...</div></div>';
  try {
    const [expRes,incRes,loanRes,cfgRes,emiRes,emiPayRes] = await Promise.all([
      api({action:'getExpenses',userId:currentUser.id}),
      api({action:'getIncome',userId:currentUser.id}),
      api({action:'getLoans',userId:currentUser.id}),
      api({action:'getConfig',userId:currentUser.id}),
      api({action:'getEMIs',userId:currentUser.id}),
      api({action:'getEMIPayments',userId:currentUser.id})
    ]);
    if (expRes.success) appData.expenses = expRes.data; // _rowIndex comes from server
    if (incRes.success) appData.income = incRes.data; // _rowIndex comes from server
    if (loanRes.success) { appData.loans = loanRes.data; appData.loanSummary = loanRes.summary; }
    if (cfgRes&&cfgRes.success) appData.config = cfgRes.config;
    if (emiRes.success) appData.emis = emiRes.data;
    if (emiPayRes.success) appData.emiPayments = emiPayRes.data;
    buildMonthChips();
    buildDashMonthChips();
    populateCategorySelects();
    renderAll();
  } catch(e) {
    showToast('Failed to load data');
    document.getElementById('dash-recent').innerHTML = '<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="8" y1="12" x2="16" y2="12"/></svg><div class="empty-state-text">Connection failed</div></div>';
  }
}

// ── CATEGORY SELECTS ──
function getActiveCategories(type) {
  const defaults = type === 'expense' ? DEFAULT_EXPENSE : type === 'income' ? DEFAULT_INCOME : DEFAULT_LOAN;
  const saved = configState[type];
  const active = defaults.filter(c => saved.checked.has(c));
  return [...active, ...saved.custom];
}

function populateCategorySelects() {
  // Apply saved config from sheet
  if (appData.config) {
    const cfg = appData.config;
    // Apply custom items
    ['expense','income','loan'].forEach(t => {
      const key = t + 'Custom';
      const arr = cfg[key] || [];
      arr.forEach(c => { if (c) configState[t].custom.push(c); });
      configState[t].custom = [...new Set(configState[t].custom)];
    });
    // Apply unchecked defaults (remove from checked set)
    const uncheckedMap = {
      expense: cfg.expenseUnchecked || [],
      income:  cfg.incomeUnchecked  || [],
      loan:    cfg.loanUnchecked    || [],
      emi:     cfg.emiUnchecked     || []
    };
    // Apply custom EMI items
    (cfg.emiCustom || []).forEach(c => { if (c) configState.emi.custom.push(c); });
    configState.emi.custom = [...new Set(configState.emi.custom)];
    ['expense','income','loan','emi'].forEach(t => {
      uncheckedMap[t].forEach(c => configState[t].checked.delete(c));
    });
  }
  fillSelect('exp-cat', getActiveCategories('expense'));
  fillSelect('inc-cat', getActiveCategories('income'));
}

function fillSelect(id, opts) {
  const sel = document.getElementById(id);
  if (!sel) return;
  sel.innerHTML = opts.map(o => `<option>${o}</option>`).join('');
}

// ── FILTER CHIPS ──
function buildMonthChips() {
  const months = new Set();
  [...appData.expenses,...appData.income].forEach(r => {
    const ts = parseSheetDate(r['Date']);
    if (ts) { const d = new Date(ts); months.add(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`); }
  });
  const sorted = [...months].sort().reverse();
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  ['exp-filter-bar','inc-filter-bar'].forEach((barId,i) => {
    const fn = i===0?'setExpFilter':'setIncFilter';
    const activeVal = i===0 ? expFilterVal : incFilterVal;
    const bar = document.getElementById(barId);
    const allActive = activeVal === 'all' ? ' active' : '';
    bar.innerHTML = `<div class="filter-chip${allActive}" data-val="all" onclick="${fn}(this)">All</div>` +
      sorted.map(m => {
        const [y,mo] = m.split('-');
        const isActive = m === activeVal ? ' active' : '';
        return `<div class="filter-chip${isActive}" data-val="${m}" onclick="${fn}(this)">${monthNames[+mo-1]} ${y}</div>`;
      }).join('');
  });
}

function buildDashMonthChips() {
  const months = new Set();
  [...appData.expenses,...appData.income].forEach(r => {
    const ts = parseSheetDate(r['Date']);
    if (ts) { const d = new Date(ts); months.add(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`); }
  });
  const sorted = [...months].sort().reverse();
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const bar = document.getElementById('dash-filter-bar');
  const existing = '<div class="dash-chip" data-type="today" onclick="setDashFilter(this)">Today</div><div class="dash-chip" data-type="week" onclick="setDashFilter(this)">This Week</div><div class="dash-chip active" data-type="month" onclick="setDashFilter(this)">This Month</div><div class="dash-chip" data-type="range" onclick="setDashFilter(this)">Custom</div>';
  const monthChips = sorted.map(m => {
    const [y,mo] = m.split('-');
    return `<div class="dash-chip" data-type="${m}" onclick="setDashFilter(this)">${monthNames[+mo-1]} ${y}</div>`;
  }).join('');
  bar.innerHTML = existing + monthChips;
}

function setExpFilter(el) {
  document.querySelectorAll('#exp-filter-bar .filter-chip').forEach(c=>c.classList.remove('active'));
  el.classList.add('active'); expFilterVal = el.dataset.val; renderExpenses();
}
function setIncFilter(el) {
  document.querySelectorAll('#inc-filter-bar .filter-chip').forEach(c=>c.classList.remove('active'));
  el.classList.add('active'); incFilterVal = el.dataset.val; renderIncome();
}

function filterByMonth(rows, dateKey, filterVal) {
  if (filterVal==='all') return rows;
  return rows.filter(r => {
    const ts = parseSheetDate(r[dateKey]);
    if (!ts) return false;
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}` === filterVal;
  });
}

function setDashFilter(el) {
  document.querySelectorAll('.dash-chip').forEach(c=>c.classList.remove('active'));
  el.classList.add('active');
  dashFilterType = el.dataset.type;
  const rangeRow = document.getElementById('dash-range-row');
  rangeRow.classList.toggle('show', dashFilterType==='range');
  if (dashFilterType !== 'range') renderDashboard();
}

function applyDashRange() {
  dashFilterRange.from = document.getElementById('dash-from').value;
  dashFilterRange.to = document.getElementById('dash-to').value;
  if (!dashFilterRange.from||!dashFilterRange.to){showToast('Select both dates');return;}
  renderDashboard();
}

// ── RENDER ALL ──
function renderAll() { renderDashboard(); renderExpenses(); renderIncome(); renderLoans(); renderEMIs(); updateEyeIcon(); }

// ── RENDER DASHBOARD ──
function renderDashboard() {
  const {from,to} = getDateRange(dashFilterType==='range' ? 'range' : dashFilterType);
  const filtExp = appData.expenses.filter(r => { const ts=parseSheetDate(r['Date']); return ts>=from&&ts<=to; });
  const filtInc = appData.income.filter(r => { const ts=parseSheetDate(r['Date']); return ts>=from&&ts<=to; });
  const totalInc = filtInc.reduce((s,r)=>s+Number(r['Income Amount']||0),0);
  const totalExp = filtExp.reduce((s,r)=>s+Number(r['Expense Amount']||0),0);
  const net = totalInc - totalExp;
  document.getElementById('dash-balance').innerHTML = fmtBalance(net);
  document.getElementById('dash-income').textContent = fmtMini(totalInc);
  document.getElementById('dash-expense').textContent = fmtMini(totalExp);
  // Loans are always total (not date-filtered since they span months)
  let toRec=0,toPay=0;
  (appData.loanSummary||[]).forEach(l=>{
    if(l.type==='Lent'&&l.remaining>0) toRec+=l.remaining;
    if(l.type==='Borrowed'&&l.remaining>0) toPay+=l.remaining;
  });
  document.getElementById('dash-receive').textContent = fmt(toRec);
  document.getElementById('dash-owe').textContent = fmt(toPay);
  // Period label
  const labels = {today:'Today',week:'This Week',month:'This Month',range:'Custom Range'};
  let label = labels[dashFilterType];
  if (!label) { // month chip
    const [y,m] = dashFilterType.split('-');
    const mn = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    label = mn[+m-1]+' '+y;
  }
  document.getElementById('dash-period-label').textContent = label;
  // Recent 10
  const allExp = filtExp.map((r,i)=>({...r,_type:'expense',_amt:r['Expense Amount'],_date:r['Date'],_cat:r['Category'],_desc:r['Description'],_pm:r['Payment Mode'],_idx:appData.expenses.indexOf(r)}));
  const allInc = filtInc.map((r,i)=>({...r,_type:'income',_amt:r['Income Amount'],_date:r['Date'],_cat:r['Category'],_desc:r['Description'],_pm:r['Payment Mode'],_idx:appData.income.indexOf(r)}));
  const all = [...allExp,...allInc].sort((a,b)=>sortKey(b,b._idx)-sortKey(a,a._idx)).slice(0,10);
  document.getElementById('dash-recent').innerHTML = all.length ? all.map(entryHTML).join('') : emptyState('No transactions','for this period');
}

// ── RENDER EXPENSES ──
function renderExpenses() {
  const rows = filterByMonth(appData.expenses,'Date',expFilterVal).map((r,i)=>({...r,_idx:appData.expenses.indexOf(r),_rowIndex:r._rowIndex})).sort((a,b)=>sortKey(b,b._idx)-sortKey(a,a._idx));
  const total = rows.reduce((s,r)=>s+Number(r['Expense Amount']||0),0);
  document.getElementById('exp-total').textContent = fmt(total);
  document.getElementById('exp-count').textContent = rows.length+' entries';
  document.getElementById('expenses-list').innerHTML = rows.length
    ? rows.map(r=>entryHTML({...r,_type:'expense',_amt:r['Expense Amount'],_date:r['Date'],_cat:r['Category'],_desc:r['Description'],_pm:r['Payment Mode']})).join('')
    : emptyState('No expenses','Add your first expense');
}

// ── RENDER INCOME ──
function renderIncome() {
  const rows = filterByMonth(appData.income,'Date',incFilterVal).map((r,i)=>({...r,_idx:appData.income.indexOf(r),_rowIndex:r._rowIndex})).sort((a,b)=>sortKey(b,b._idx)-sortKey(a,a._idx));
  const total = rows.reduce((s,r)=>s+Number(r['Income Amount']||0),0);
  document.getElementById('inc-total').textContent = fmt(total);
  document.getElementById('inc-count').textContent = rows.length+' entries';
  document.getElementById('income-list').innerHTML = rows.length
    ? rows.map(r=>entryHTML({...r,_type:'income',_amt:r['Income Amount'],_date:r['Date'],_cat:r['Category'],_desc:r['Description'],_pm:r['Payment Mode']})).join('')
    : emptyState('No income','Add your first income');
}

// ── RENDER LOANS ──
function renderLoans() {
  let toRec=0,toPay=0;
  (appData.loanSummary||[]).forEach(l=>{
    if(l.type==='Lent'&&l.remaining>0) toRec+=l.remaining;
    if(l.type==='Borrowed'&&l.remaining>0) toPay+=l.remaining;
  });
  document.getElementById('loan-receive').textContent = fmt(toRec);
  document.getElementById('loan-pay').textContent = fmt(toPay);
  const el = document.getElementById('loans-list');
  if(!appData.loanSummary||!appData.loanSummary.length){el.innerHTML=emptyState('No loans','Add a loan to track it');return;}
  // Sort loans by most recent entry date (latest first)
  const sortedLoans = [...appData.loanSummary].sort((a, b) => {
    const aEntries = appData.loans.filter(r => String(r['Loan ID']).trim() === a.loanId);
    const bEntries = appData.loans.filter(r => String(r['Loan ID']).trim() === b.loanId);
    const aMax = aEntries.length ? Math.max(...aEntries.map(r => sortKey(r, null))) : 0;
    const bMax = bEntries.length ? Math.max(...bEntries.map(r => sortKey(r, null))) : 0;
    return bMax - aMax;
  });
  el.innerHTML = sortedLoans.map(loanCardHTML).join('');
}

function loanCardHTML(l) {
  const isLent = l.type==='Lent';
  const color = isLent?'var(--red)':'var(--green)';
  const bg = isLent?'rgba(234,67,53,.15)':'rgba(52,168,83,.15)';
  const badgeClass = l.remaining<=0?'settled':(isLent?'lent':'borrowed');
  const badgeText = l.remaining<=0?'Settled':(isLent?'Lent':'Borrowed');
  const pct = l.principal>0 ? Math.min(100,Math.round(((l.principal-l.remaining)/l.principal)*100)) : 100;
  return `<div class="loan-card" onclick="openLoanAction('${l.loanId}')">
    <div class="loan-card-header">
      <div class="loan-card-left">
        <div class="loan-person-avatar" style="background:${bg};color:${color}">${l.person[0].toUpperCase()}</div>
        <div><div class="loan-person-name">${l.person}</div><div class="loan-person-meta">${l.loanId} · ${l.type}</div></div>
      </div>
      <div class="loan-card-right">
        <div class="loan-amount" style="color:${color}">${fmt(l.remaining)}</div>
        <div class="loan-badge ${badgeClass}">${badgeText}</div>
      </div>
    </div>
    <div class="loan-progress-bar">
      <div class="loan-progress-fill" style="width:${pct}%;background:${color}"></div>
    </div>
    <div style="display:flex;justify-content:flex-end;padding:4px 12px 10px">
      <button onclick="event.stopPropagation();deleteLoanConfirm('${l.loanId}')"
        style="background:rgba(217,48,37,.08);border:1px solid rgba(217,48,37,.18);
        border-radius:8px;padding:6px 12px;cursor:pointer;color:var(--red);
        font-size:11px;font-weight:700;display:flex;align-items:center;gap:5px">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        Delete Loan
      </button>
    </div>
  </div>`;
}

// ── ENTRY HTML ──
// Registry to avoid JSON serialization issues in onclick
const _entryRegistry = {};
let _entryRegIdx = 0;

function entryHTML(r) {
  const isInc = r._type==='income';
  const color = isInc?'var(--green)':'var(--red)';
  const bg = isInc?'rgba(52,168,83,.12)':'rgba(234,67,53,.12)';
  const sign = isInc?'+':'-';
  const icon = isInc
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2"><polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/></svg>`;
  const remarks = r['Remarks'] || r.Remarks || '';
  const key = 'e' + (_entryRegIdx++);
  _entryRegistry[key] = r;
  return `<div class="entry-item" onclick="openEntryDetail('${key}')">
    <div class="entry-icon" style="background:${bg}">${icon}</div>
    <div class="entry-info">
      <div class="entry-cat">${r._cat||''}</div>
      <div class="entry-desc">${r._desc||''}</div>
      <div class="entry-date">${fmtDisplay(r._date)}${remarks&&remarks!=='-'?' · <span style="color:var(--text2)">'+remarks+'</span>':''}</div>
    </div>
    <div class="entry-right">
      <div class="entry-amount" style="color:${color}">${sign}${fmt(r._amt||0)}</div>
      <div class="entry-pm">${r._pm||''}</div>
    </div>
  </div>`;
}

function emptyState(title,sub='') {
  return `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="8" y1="12" x2="16" y2="12"/></svg><div class="empty-state-text">${title}</div><div class="empty-state-sub">${sub}</div></div>`;
}

// ── NAVIGATION ──
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
function switchPage(name) {
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  document.getElementById('page-'+name).classList.add('active');
  const navEl = document.querySelector(`[data-page="${name}"]`);
  if (navEl) navEl.classList.add('active');
  currentPage = name;
}

// ── OVERLAYS ──
function closeOverlay(id,e) { if(!e||e.target===document.getElementById(id)) document.getElementById(id).classList.remove('open'); }
function openProfile() { document.getElementById('profile-overlay').classList.add('open'); }
function openReport() { closeOverlay('profile-overlay'); setTimeout(()=>document.getElementById('report-overlay').classList.add('open'),200); }
function openConfig() { closeOverlay('profile-overlay'); renderConfigSheet(); setTimeout(()=>document.getElementById('config-overlay').classList.add('open'),200); }

// ── ADD MODAL ──
function openAddModal() {
  if (currentPage === 'emis') {
    const d = todayISO();
    const now = new Date();
    // Both start and payment dates restricted to current month onwards
    const curMonthMin = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;

    const startInput = document.getElementById('new-emi-start');
    const payInput   = document.getElementById('new-emi-paid');
    const totalInput = document.getElementById('new-emi-total');
    const emiInput   = document.getElementById('new-emi-amount');
    const countInput = document.getElementById('new-emi-count');

    startInput.value = d;
    startInput.min   = curMonthMin;
    payInput.value   = d;
    payInput.min     = curMonthMin;

    // Enforce paid >= start on start change
    startInput.onchange = () => {
      if (payInput.value < startInput.value) payInput.value = startInput.value;
      payInput.min = startInput.value > curMonthMin ? startInput.value : curMonthMin;
    };

    // Auto-calc Total EMIs from total amount / emi amount
    const calcEMIs = () => {
      const t = Number(totalInput.value);
      const e = Number(emiInput.value);
      if (t > 0 && e > 0 && e <= t) {
        countInput.value = Math.ceil(t / e);
      } else {
        countInput.value = '';
      }
    };
    totalInput.oninput = calcEMIs;
    emiInput.oninput   = calcEMIs;

    // countInput is readonly — driven by auto-calc
    countInput.readOnly    = true;
    countInput.placeholder = 'Auto-calculated';
    countInput.style.background = 'var(--surface2)';
    countInput.style.color      = 'var(--text2)';

    populateEMICatSelect();
    document.getElementById('emi-add-overlay').classList.add('open');
    return;
  }
  const d = todayISO();
  ['exp-date','inc-date','loan-date'].forEach(id=>document.getElementById(id).value=d);
  const tabMap = {expenses:'expense',income:'income',loans:'loan',dashboard:'expense'};
  switchAddTab(tabMap[currentPage]||'expense');
  document.getElementById('add-overlay').classList.add('open');
}
function switchAddTab(tab) {
  currentAddTab = tab;
  const tabs = ['expense','income','loan'];
  document.querySelectorAll('#add-tabs .sheet-tab').forEach((t,i)=>t.classList.toggle('active',tabs[i]===tab));
  tabs.forEach(t=>{ document.getElementById('add-'+t).style.display = t===tab?'block':'none'; });
}

// ── LOAN ACTION ──
function openLoanAction(loanId) {
  currentLoanAction = appData.loanSummary.find(l=>l.loanId===loanId);
  if (!currentLoanAction) return;
  const l = currentLoanAction;
  const isLent    = l.type==='Lent';
  const isSettled = l.remaining <= 0;
  const color = isLent?'var(--red)':'var(--green)';
  const pct   = l.principal>0 ? Math.min(100,Math.round(((l.principal-l.remaining)/l.principal)*100)) : 100;
  document.getElementById('la-header').innerHTML = `
    <div class="la-name">${l.person} <span style="font-size:12px;color:var(--text2);font-weight:500">(${l.loanId})</span></div>
    <div class="la-meta">${isLent?'You lent':'You borrowed'} · ${l.type}${isSettled?' · <span style="color:var(--green);font-weight:700">Settled ✓</span>':''}</div>
    <div style="margin-top:8px;font-size:12px;color:var(--text2);display:flex;justify-content:space-between">
      <span>Principal: ${fmt(l.principal)}</span>
      <span>Remaining: <strong style="color:${isSettled?'var(--green)':color}">${fmt(l.remaining)}</strong></span>
    </div>
    <div class="la-prog-bar"><div class="la-prog-fill" style="width:${pct}%;background:${isSettled?'var(--green)':color}"></div></div>
    <div class="la-prog-text"><span>${pct}% settled</span><span>${fmt(l.principal-l.remaining)} done</span></div>`;
  if (isSettled) {
    // Settled: only show history tab
    document.querySelectorAll('#la-tabs .sheet-tab').forEach((t,i) => {
      t.style.display = i===0?'none':'block';
      t.classList.toggle('active', i===1);
    });
    document.getElementById('la-repay').style.display = 'none';
    document.getElementById('la-history').style.display = 'block';
    renderLoanHistory();
  } else {
    document.querySelectorAll('#la-tabs .sheet-tab').forEach(t => { t.style.display='block'; });
    document.getElementById('la-submit-btn').textContent = isLent?'Collect Payment':'Repay Loan';
    document.getElementById('la-date').value = todayISO();
    document.getElementById('la-amount').value = '';
    switchLaTab('repay');
  }
  document.getElementById('loan-action-overlay').classList.add('open');
}

function switchLaTab(tab) {
  document.querySelectorAll('#la-tabs .sheet-tab').forEach((t,i)=>t.classList.toggle('active',['repay','history'][i]===tab));
  document.getElementById('la-repay').style.display = tab==='repay'?'block':'none';
  document.getElementById('la-history').style.display = tab==='history'?'block':'none';
  if (tab==='history') renderLoanHistory();
}

function renderLoanHistory() {
  const l = currentLoanAction;
  if (!l) return;
  const entries = appData.loans.filter(r=>String(r['Loan ID']).trim()===l.loanId).sort((a,b)=>sortKey(b,null)-sortKey(a,null));
  const el = document.getElementById('la-history-list');
  if (!entries.length) { el.innerHTML='<div style="text-align:center;color:var(--text3);padding:20px">No entries</div>'; return; }
  el.innerHTML = entries.map(r=>{
    const cat = r['Category'];
    const isOut = ['Lent','Repaid'].includes(cat);
    const color = isOut?'var(--red)':'var(--green)';
    return `<div class="loan-entry-item">
      <div><div class="le-cat" style="color:${color}">${cat}</div><div class="le-date">${fmtDisplay(r['Date'])}</div></div>
      <div class="le-amt" style="color:${color}">${fmt(r['Loan Amount'])}</div>
    </div>`;
  }).join('');
}

async function submitLoanAction() {
  const l = currentLoanAction;
  if (!l) return;
  const amount = Number(document.getElementById('la-amount').value);
  const date = fmtDateForSheet(document.getElementById('la-date').value);
  const pm = document.getElementById('la-pm').value;
  const remarks = document.getElementById('la-remarks').value||'-';
  if (!amount||amount<=0){showToast('Enter a valid amount');return;}
  if (amount>l.remaining){showToast(`Max: ${fmt(l.remaining)}`);return;}
  const isLent = l.type==='Lent';
  const category = isLent?'Collected':'Repaid';
  const btn = document.getElementById('la-submit-btn');
  btn.textContent='Saving...'; btn.disabled=true;
  try {
    const res = await api({action:'addLoanAction',userId:currentUser.id,loanId:l.loanId,date,category,description:l.person,paymentMode:pm,amount,remarks});
    if (res.success) { showToast(isLent?'Payment collected':'Repayment recorded'); closeOverlay('loan-action-overlay'); await loadAllData(); }
    else { showToast('Error: '+(res.error||'Failed')); }
  } catch(e) { showToast('Connection error'); }
  btn.textContent = isLent?'Collect Payment':'Repay Loan'; btn.disabled=false;
}

// ── SUBMIT FORMS ──
async function submitExpense() {
  const p = {action:'addExpense',userId:currentUser.id,date:fmtDateForSheet(document.getElementById('exp-date').value),amount:document.getElementById('exp-amount').value,category:document.getElementById('exp-cat').value,description:document.getElementById('exp-desc').value,paymentMode:document.getElementById('exp-pm').value,remarks:document.getElementById('exp-remarks').value||'-'};
  if(!p.amount||!p.description){showToast('Fill required fields');return;}
  await submitEntry(p,'Expense added');
}
async function submitIncome() {
  const p = {action:'addIncome',userId:currentUser.id,date:fmtDateForSheet(document.getElementById('inc-date').value),amount:document.getElementById('inc-amount').value,category:document.getElementById('inc-cat').value,description:document.getElementById('inc-desc').value,paymentMode:document.getElementById('inc-pm').value,remarks:document.getElementById('inc-remarks').value||'-'};
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

// ── CONFIGURATION ──
function renderConfigSheet() {
  renderConfigSection('expense','Expense Categories','config-expense-section');
  renderConfigSection('income','Income Categories','config-income-section');
  renderConfigSection('loan','Loan Types','config-loan-section');
  renderConfigSection('emi','EMI Types','config-emi-section');
}

function renderConfigSection(type, title, sectionId) {
  const defaults = type==='expense'?DEFAULT_EXPENSE:type==='income'?DEFAULT_INCOME:type==='loan'?DEFAULT_LOAN:DEFAULT_EMI;
  const state = configState[type];
  const el = document.getElementById(sectionId);
  let html = `<div class="config-section-title">${title}</div>`;
  defaults.forEach(cat => {
    const checked = state.checked.has(cat) ? 'checked' : '';
    html += `<div class="config-item">
      <div style="display:flex;align-items:center;gap:8px">
        <span class="config-item-label">${cat}</span>
        <span class="config-item-badge">Default</span>
      </div>
      <input type="checkbox" class="checkbox" data-type="${type}" data-cat="${cat}" ${checked} onchange="toggleConfigCat(this)">
    </div>`;
  });
  state.custom.forEach(cat => {
    html += `<div class="config-item">
      <span class="config-item-label">${cat}</span>
      <div style="display:flex;align-items:center;gap:8px">
        <span class="config-item-badge" style="background:rgba(26,115,232,.1);color:var(--blue)">Custom</span>
        <button onclick="removeCustomCat('${type}','${cat}')" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:18px;line-height:1">×</button>
      </div>
    </div>`;
  });
  html += `<div class="config-add-row">
    <input type="text" id="config-add-${type}" placeholder="Add custom ${type} category">
    <button class="btn btn-primary btn-sm" onclick="addCustomCat('${type}')">Add</button>
  </div>`;
  el.innerHTML = html;
}

function toggleConfigCat(el) {
  const type = el.dataset.type, cat = el.dataset.cat;
  if (el.checked) configState[type].checked.add(cat);
  else configState[type].checked.delete(cat);
}
function addCustomCat(type) {
  const inp = document.getElementById(`config-add-${type}`);
  const val = inp.value.trim();
  if (!val) { showToast('Enter a category name'); return; }
  if (configState[type].custom.includes(val) || DEFAULT_EXPENSE.concat(DEFAULT_INCOME,DEFAULT_LOAN).includes(val)) { showToast('Already exists'); return; }
  configState[type].custom.push(val);
  inp.value = '';
  const titleMap = {expense:'Expense Categories',income:'Income Categories',loan:'Loan Types',emi:'EMI Types'};
  renderConfigSection(type, titleMap[type]||type, `config-${type}-section`);
}
function removeCustomCat(type, cat) {
  configState[type].custom = configState[type].custom.filter(c=>c!==cat);
  const titleMap = {expense:'Expense Categories',income:'Income Categories',loan:'Loan Types',emi:'EMI Types'};
  renderConfigSection(type, titleMap[type]||type, `config-${type}-section`);
}

async function saveConfig() {
  const btn = document.querySelector('#config-overlay .btn-primary');
  btn.textContent = 'Saving...'; btn.disabled = true;
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
    if (res.success) { showToast('Configuration saved'); populateCategorySelects(); closeOverlay('config-overlay'); }
    else { showToast('Error: '+(res.error||'Failed')); }
  } catch(e) { showToast('Connection error'); }
  btn.textContent = 'Save Configuration'; btn.disabled = false;
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

  const win = window.open('','_blank');
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
  @media print { body{-webkit-print-color-adjust:exact;print-color-adjust:exact;} }
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <img src="${logoSrc}" class="header-logo" alt="Wallet">
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
<' + 'script>window.onload=()=>{window.print();}<' + '/script>
</body></html>`;
  win.document.write(html);
  win.document.close();
  showToast('PDF ready — use browser Print');
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
  try { localStorage.setItem('wallet_bal_hidden', balanceHidden ? '1' : '0'); } catch(e) {}
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
    // Closed: hide Pay/Miss tab, show only History
    document.querySelectorAll('#emi-action-tabs .sheet-tab').forEach((t,i)=>{
      t.style.display = i===0?'none':'block';
      t.classList.toggle('active', i===1);
    });
    document.getElementById('emi-pay-form').style.display = 'none';
    document.getElementById('emi-history').style.display  = 'block';
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
  document.querySelectorAll('#emi-action-tabs .sheet-tab').forEach((t,i) => t.classList.toggle('active',['pay','history'][i]===tab));
  document.getElementById('emi-pay-form').style.display = tab==='pay'?'block':'none';
  document.getElementById('emi-history').style.display = tab==='history'?'block':'none';
  if (tab==='history') renderEMIHistory();
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
function showConfirm(msg, onOk) {
  _confirmCallback = onOk;
  document.getElementById('confirm-msg').textContent = msg;
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

  editForm.innerHTML = `
    <div class="form-group"><div class="field-label">Date</div><input type="date" id="edit-date" value="${isoDate}"></div>
    <div class="form-group"><div class="field-label">Amount ₹</div><input type="number" id="edit-amount" value="${amt}" inputmode="decimal"></div>
    <div class="form-group"><div class="field-label">Category</div><select id="edit-cat">${catOpts}</select></div>
    <div class="form-group"><div class="field-label">Description</div><input type="text" id="edit-desc" value="${desc}"></div>
    <div class="form-group"><div class="field-label">Payment Mode</div><select id="edit-pm">${pmOpts}</select></div>
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
      paymentMode: newPM, remarks: newRemarks
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
