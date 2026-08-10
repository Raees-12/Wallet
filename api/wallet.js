const { supabaseAdmin } = require('../lib/supabaseAdmin');
const { authenticate, updateProfile } = require('../lib/auth');
const { parseDMY, formatDMY, addMonthsOnDay, genId, toNum } = require('../lib/helpers');

const db = supabaseAdmin;

// Category used for mirrored EMI-payment expense rows (loan mirrors use the
// loan's own Lent/Borrowed/Collected/Repaid category instead — see addLoan/repayLoan).
const MIRROR_EXPENSE_CATEGORY = 'EMIs & Loans';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const params = req.method === 'GET' ? req.query : (req.body || {});
  const action = params.action;

  // ── Authorisation gate ──────────────────────────────────────────────
  // Every action requires a valid Supabase access token. The user id is taken
  // from the verified token, never from the request, so a caller cannot ask
  // for somebody else's data by editing a query string.
  const auth = await authenticate(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ success: false, error: auth.error, authRequired: true });
  }
  const ctx = { ...params, userId: auth.walletId, _auth: auth };

  try {
    switch (action) {
      case 'me':                  return res.json(await me(ctx));
      case 'updateProfile':       return res.json(await saveProfile(ctx));
      case 'getAllData':          return res.json(await getAllData(ctx));
      case 'addExpense':          return res.json(await addExpense(ctx));
      case 'editExpense':         return res.json(await editExpense(ctx));
      case 'deleteExpense':       return res.json(await deleteExpense(ctx));
      case 'addIncome':           return res.json(await addIncome(ctx));
      case 'editIncome':          return res.json(await editIncome(ctx));
      case 'deleteIncome':        return res.json(await deleteIncome(ctx));
      case 'addLoan':             return res.json(await addLoan(ctx));
      case 'editLoan':            return res.json(await editLoan(ctx));
      case 'repayLoan':           return res.json(await repayLoan(ctx));
      case 'deleteLoanById':      return res.json(await deleteLoanById(ctx));
      case 'addEMI':              return res.json(await addEMI(ctx));
      case 'editEMI':             return res.json(await editEMI(ctx));
      case 'addProgressEMI':      return res.json(await addProgressEMI(ctx));
      case 'payEMI':              return res.json(await payEMI(ctx));
      case 'markEMIMissed':       return res.json(await markEMIMissed(ctx));
      case 'deleteEMIById':       return res.json(await deleteEMIById(ctx));
      case 'saveConfig':          return res.json(await saveConfig(ctx));
      case 'addAccount':          return res.json(await addAccount(ctx));
      case 'editAccount':         return res.json(await editAccount(ctx));
      case 'deleteAccount':       return res.json(await deleteAccount(ctx));
      case 'importData':          return res.json(await importData(ctx));
      case 'clearData':           return res.json(await clearData(ctx));
      case 'saveSettings':        return res.json(await saveSettings(ctx));
      case 'deleteMyAccount':     return res.json(await deleteMyAccount(ctx));
      default:
        return res.status(400).json({ success: false, error: `Unknown action: ${action}` });
    }
  } catch (e) {
    console.error(`[${action}] error:`, e);
    return res.status(200).json({ success: false, error: e.message || 'Server error' });
  }
};

// ══════════════════════════════════════════════════════════════
// IDENTITY
// The client asks who it is rather than asserting it.
// ══════════════════════════════════════════════════════════════
async function me({ _auth }) {
  const p = _auth.profile;
  return {
    success: true,
    user: {
      id: _auth.walletId,               // what wallet rows are keyed by
      authId: _auth.authId,             // the Supabase auth UUID
      username: p.firstName || (p.email ? p.email.split('@')[0] : 'You'),
      firstName: p.firstName,
      lastName: p.lastName,
      fullName: p.fullName,
      mobile: p.mobile,
      email: _auth.email,
      createdAt: _auth.createdAt,
    },
  };
}

async function saveProfile({ _auth, firstName, lastName, mobile }) {
  return updateProfile(_auth.walletId, { firstName, lastName, mobile });
}

// ══════════════════════════════════════════════════════════════
// GET ALL DATA
// ══════════════════════════════════════════════════════════════
async function getAllData({ userId }) {
  if (!userId) return { success: false, error: 'userId required' };

  const [expenses, income, loans, emis, emiPayments, cfgRows, accounts, settings] = await Promise.all([
    db.from('expenses').select('*').eq('ID', userId),
    db.from('income').select('*').eq('ID', userId),
    db.from('loan').select('*').eq('ID', userId),
    db.from('emi').select('*').eq('ID', userId),
    db.from('emi_payments').select('*').eq('ID', userId),
    db.from('personalised_configuration').select('*').eq('ID', userId),
    db.from('bank_accounts').select('*').eq('ID', userId),
    db.from('user_settings').select('*').eq('ID', userId).maybeSingle(),
  ]);
  for (const r of [expenses, income, loans, emis, emiPayments, cfgRows]) if (r.error) throw r.error;
  // The accounts table is optional — if the migration hasn't been run yet the
  // rest of the app keeps working and the account features stay hidden.
  const accountRows = accounts.error ? [] : (accounts.data || []);
  // Both tables are optional — if their migrations haven't been run the rest of
  // the app still works and these features simply stay dormant.
  const userSettings = (settings.error || !settings.data) ? null : (settings.data['Settings'] || {});

  const config = buildConfig(cfgRows.data || []);

  return {
    success: true,
    expenses: withRowIndex(expenses.data || []),
    income: withRowIndex(income.data || []),
    loans: loans.data || [],
    loanSummary: buildLoanSummary(loans.data || []),
    emis: emis.data || [],
    emiPayments: emiPayments.data || [],
    accounts: accountRows
      .map(a => ({ rowId: a.row_id, name: a['Account Name'], opening: toNum(a['Opening Balance']) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    settings: userSettings,
    config,
  };
}

// The frontend identifies a specific expense/income row via `_rowIndex` when
// editing/deleting. Supabase's auto-increment `row_id` is a perfect stable ID for this.
function withRowIndex(rows) {
  return rows.map(r => ({ ...r, _rowIndex: r.row_id }));
}

// Config is stored as one-or-more rows per "Configuration Type" label,
// e.g. "Expense Type Custom", with up to 10 values spread across C1-C10.
// A long list just spans multiple rows.
const CONFIG_TYPE_LABELS = { expense: 'Expense', income: 'Income', loan: 'Loan', emi: 'EMI' };
const C_COLS = ['C1','C2','C3','C4','C5','C6','C7','C8','C9','C10'];

function customTypeName(type)    { return `${CONFIG_TYPE_LABELS[type]} Type Custom`; }
function uncheckedTypeName(type) { return `${CONFIG_TYPE_LABELS[type]} Type Unchecked`; }

function collectValues(rows, typeName) {
  return rows
    .filter(r => r['Configuration Type'] === typeName)
    .flatMap(r => C_COLS.map(c => r[c]))
    .filter(v => v !== null && v !== undefined && String(v).trim() !== '');
}

function buildConfig(cfgRows) {
  const config = {};
  for (const type of Object.keys(CONFIG_TYPE_LABELS)) {
    config[type + 'Custom']    = collectValues(cfgRows, customTypeName(type)).join(',');
    config[type + 'Unchecked'] = collectValues(cfgRows, uncheckedTypeName(type)).join(',');
  }
  return config;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Replaces all rows for (userId, typeName) with fresh rows built from `list`.
// Deleting first (rather than accumulating forever like the old sheet did)
// keeps the table clean and getAllData's aggregation correct.
async function replaceConfigRows(userId, typeName, list) {
  const { error: delErr } = await db
    .from('personalised_configuration')
    .delete()
    .eq('ID', userId)
    .eq('Configuration Type', typeName);
  if (delErr) throw delErr;

  const values = (list || []).map(s => s.trim()).filter(Boolean);
  if (!values.length) return;

  const rows = chunk(values, 10).map(group => {
    const row = { ID: userId, 'Configuration Type': typeName };
    C_COLS.forEach((c, i) => { row[c] = group[i] || null; });
    return row;
  });
  const { error: insErr } = await db.from('personalised_configuration').insert(rows);
  if (insErr) throw insErr;
}

function buildLoanSummary(loanRows) {
  const groups = {};
  for (const r of loanRows) {
    const loanId = String(r['Loan ID'] || '').trim();
    if (!loanId) continue;
    (groups[loanId] = groups[loanId] || []).push(r);
  }
  const summary = [];
  for (const [loanId, rows] of Object.entries(groups)) {
    const origin = rows.find(r => {
      const cat = String(r['Category'] || '').toLowerCase();
      return cat === 'lent' || cat === 'borrowed';
    });
    if (!origin) continue;
    const type = origin['Category'];
    const total = toNum(origin['Loan Amount']);
    const paid = rows
      .filter(r => r !== origin)
      .reduce((s, r) => s + toNum(r['Loan Amount']), 0);
    summary.push({
      loanId,
      person: origin['Description'] || 'Unknown',
      // Shown as the loan's title in the UI, falling back to the person's name
      remarks: String(origin['Remarks'] || '').trim(),
      type,
      total,
      pending: total - paid,
    });
  }
  return summary;
}

// ══════════════════════════════════════════════════════════════
// EXPENSE / INCOME
// ══════════════════════════════════════════════════════════════
async function addExpense(p) {
  const { userId, date, amount, category, description, paymentMode, remarks, account } = p;
  if (!userId || !amount || !description) return { success: false, error: 'Missing required fields' };
  const { error } = await db.from('expenses').insert({
    ID: userId, Date: date, Category: category, Description: description,
    'Payment Mode': paymentMode, 'Expense Amount': toNum(amount), Remarks: remarks || '-',
    Account: account || null,
  });
  if (error) throw error;
  return { success: true };
}

async function addIncome(p) {
  const { userId, date, amount, category, description, paymentMode, remarks, account } = p;
  if (!userId || !amount || !description) return { success: false, error: 'Missing required fields' };
  const { error } = await db.from('income').insert({
    ID: userId, Date: date, Category: category, Description: description,
    'Payment Mode': paymentMode, 'Income Amount': toNum(amount), Remarks: remarks || '-',
    Account: account || null,
  });
  if (error) throw error;
  return { success: true };
}

async function editExpense(p) {
  const { userId, rowIndex, date, amount, category, description, paymentMode, remarks, account } = p;
  if (!userId || !rowIndex || !amount || !description) return { success: false, error: 'Missing required fields' };
  const { error, count } = await db.from('expenses')
    .update({
      Date: date, Category: category, Description: description,
      'Payment Mode': paymentMode, 'Expense Amount': toNum(amount), Remarks: remarks || '-',
      Account: account || null,
    }, { count: 'exact' })
    .eq('ID', userId).eq('row_id', rowIndex);
  if (error) throw error;
  if (count === 0) return { success: false, error: 'Entry not found' };
  return { success: true };
}

async function deleteExpense(p) {
  const { userId, rowIndex } = p;
  if (!userId || !rowIndex) return { success: false, error: 'Missing required fields' };
  const { error, count } = await db.from('expenses')
    .delete({ count: 'exact' })
    .eq('ID', userId).eq('row_id', rowIndex);
  if (error) throw error;
  if (count === 0) return { success: false, error: 'Entry not found' };
  return { success: true };
}

async function editIncome(p) {
  const { userId, rowIndex, date, amount, category, description, paymentMode, remarks, account } = p;
  if (!userId || !rowIndex || !amount || !description) return { success: false, error: 'Missing required fields' };
  const { error, count } = await db.from('income')
    .update({
      Date: date, Category: category, Description: description,
      'Payment Mode': paymentMode, 'Income Amount': toNum(amount), Remarks: remarks || '-',
      Account: account || null,
    }, { count: 'exact' })
    .eq('ID', userId).eq('row_id', rowIndex);
  if (error) throw error;
  if (count === 0) return { success: false, error: 'Entry not found' };
  return { success: true };
}

async function deleteIncome(p) {
  const { userId, rowIndex } = p;
  if (!userId || !rowIndex) return { success: false, error: 'Missing required fields' };
  const { error, count } = await db.from('income')
    .delete({ count: 'exact' })
    .eq('ID', userId).eq('row_id', rowIndex);
  if (error) throw error;
  if (count === 0) return { success: false, error: 'Entry not found' };
  return { success: true };
}

// ══════════════════════════════════════════════════════════════
// LOANS
// ══════════════════════════════════════════════════════════════
async function addLoan(p) {
  const { userId, date, amount, category, description, paymentMode, remarks, loanIdInput } = p;
  if (!userId || !amount || !description) return { success: false, error: 'Missing required fields' };
  const loanId = (loanIdInput && String(loanIdInput).trim()) || genId('L');
  const amt = toNum(amount);

  const { error: loanErr } = await db.from('loan').insert({
    ID: userId, 'Loan ID': loanId, Date: date, Category: category,
    Description: description, 'Payment Mode': paymentMode, 'Loan Amount': amt, Remarks: remarks || '-',
  });
  if (loanErr) throw loanErr;

  const isLent = String(category).toLowerCase() === 'lent';
  if (isLent) {
    // Money leaves your pocket when you lend it out.
    // Category must equal the loan's own category (Lent/Borrowed/Collected/Repaid) —
    // that's what the frontend's isAutoEntry() checks to lock this row from editing.
    const { error } = await db.from('expenses').insert({
      ID: userId, Date: date, Category: category, Description: description,
      'Payment Mode': paymentMode, 'Expense Amount': amt, Remarks: remarks || '-', 'Loan ID': loanId,
    });
    if (error) throw error;
  } else {
    // Money comes in when you borrow it
    const { error } = await db.from('income').insert({
      ID: userId, Date: date, Category: category, Description: description,
      'Payment Mode': paymentMode, 'Income Amount': amt, Remarks: remarks || '-', 'Loan ID': loanId,
    });
    if (error) throw error;
  }
  return { success: true, loanId };
}

async function editLoan(p) {
  const { userId, loanId, date, amount, description, paymentMode, remarks } = p;
  if (!userId || !loanId || !amount || !description) return { success: false, error: 'Missing required fields' };
  const amt = toNum(amount);

  const { data: originRows, error: findErr } = await db
    .from('loan').select('*').eq('ID', userId).eq('Loan ID', loanId);
  if (findErr) throw findErr;
  const origin = (originRows || []).find(r => {
    const cat = String(r['Category'] || '').toLowerCase();
    return cat === 'lent' || cat === 'borrowed';
  });
  if (!origin) return { success: false, error: 'Loan not found' };

  const { error: updLoanErr } = await db.from('loan')
    .update({ Date: date, Description: description, 'Payment Mode': paymentMode, 'Loan Amount': amt, Remarks: remarks || '-' })
    .eq('ID', userId).eq('row_id', origin.row_id);
  if (updLoanErr) throw updLoanErr;

  // Keep the mirrored Expense/Income row in sync — it's identified by Loan ID +
  // the loan's own category (Lent/Borrowed), which distinguishes it from any
  // repayment mirror rows (Collected/Repaid) tied to the same Loan ID.
  const mirrorTable = String(origin['Category']).toLowerCase() === 'lent' ? 'expenses' : 'income';
  const amountCol = mirrorTable === 'expenses' ? 'Expense Amount' : 'Income Amount';
  const { error: updMirrorErr } = await db.from(mirrorTable)
    .update({ Date: date, Description: description, 'Payment Mode': paymentMode, [amountCol]: amt, Remarks: remarks || '-' })
    .eq('ID', userId).eq('Loan ID', loanId).eq('Category', origin['Category']);
  if (updMirrorErr) throw updMirrorErr;

  return { success: true };
}

async function repayLoan(p) {
  const { userId, loanId, date, amount, paymentMode, remarks } = p;
  if (!userId || !loanId || !amount) return { success: false, error: 'Missing required fields' };
  const amt = toNum(amount);

  const { data: originRows, error: findErr } = await db
    .from('loan').select('*').eq('ID', userId).eq('Loan ID', loanId);
  if (findErr) throw findErr;
  const origin = (originRows || []).find(r => {
    const cat = String(r['Category'] || '').toLowerCase();
    return cat === 'lent' || cat === 'borrowed';
  });
  if (!origin) return { success: false, error: 'Loan not found' };

  const isLent = String(origin['Category']).toLowerCase() === 'lent';
  const repayCategory = isLent ? 'Collected' : 'Repaid';

  const { error: insErr } = await db.from('loan').insert({
    ID: userId, 'Loan ID': loanId, Date: date, Category: repayCategory,
    Description: origin['Description'], 'Payment Mode': paymentMode, 'Loan Amount': amt, Remarks: remarks || '-',
  });
  if (insErr) throw insErr;

  if (isLent) {
    // Collecting a loan you gave out = money received
    const { error } = await db.from('income').insert({
      ID: userId, Date: date, Category: repayCategory, Description: origin['Description'],
      'Payment Mode': paymentMode, 'Income Amount': amt, Remarks: remarks || '-', 'Loan ID': loanId,
    });
    if (error) throw error;
  } else {
    // Repaying a loan you took = money paid out
    const { error } = await db.from('expenses').insert({
      ID: userId, Date: date, Category: repayCategory, Description: origin['Description'],
      'Payment Mode': paymentMode, 'Expense Amount': amt, Remarks: remarks || '-', 'Loan ID': loanId,
    });
    if (error) throw error;
  }
  return { success: true };
}

async function deleteLoanById(p) {
  const { userId, loanId } = p;
  if (!userId || !loanId) return { success: false, error: 'Missing required fields' };
  const [a, b, c] = await Promise.all([
    db.from('loan').delete().eq('ID', userId).eq('Loan ID', loanId),
    db.from('expenses').delete().eq('ID', userId).eq('Loan ID', loanId),
    db.from('income').delete().eq('ID', userId).eq('Loan ID', loanId),
  ]);
  for (const r of [a, b, c]) if (r.error) throw r.error;
  return { success: true };
}

// ══════════════════════════════════════════════════════════════
// EMI
// ══════════════════════════════════════════════════════════════

// Fresh EMI, first installment paid right away at signup.
async function addEMI(p) {
  const {
    userId, startDate, paidDate, category, description,
    totalAmount, emiAmount, totalEMIs, billGenerateDate, paymentMode, remarks,
  } = p;
  if (!userId || !description || !totalAmount || !emiAmount || !totalEMIs) {
    return { success: false, error: 'Missing required fields' };
  }
  const emiId = genId('E');
  const total = toNum(totalAmount);
  const emiAmt = toNum(emiAmount);
  const totalN = toNum(totalEMIs);
  const billDay = toNum(billGenerateDate);
  const paidN = 1;
  const remainingN = totalN - paidN;
  const status = remainingN <= 0 ? 'Closed' : 'Active';

  const paidDateObj = parseDMY(paidDate) || new Date();
  const nextBill = addMonthsOnDay(paidDateObj, 1, billDay);
  const nextDue = nextBill; // no separate due-day input on this form

  const { error: emiErr } = await db.from('emi').insert({
    ID: userId, 'EMI ID': emiId, 'Start Date': startDate, Category: category,
    Description: description, 'Total Amount': total, 'EMI Amount': emiAmt,
    'Total EMIs': totalN, 'Paid EMIs': paidN, 'Remaining EMIs': remainingN,
    'Bill Generate Date': String(billDay), 'Next Bill Date': formatDMY(nextBill),
    'Next Due Date': formatDMY(nextDue), 'Payment Mode': paymentMode, Status: status, Remarks: remarks || '-',
  });
  if (emiErr) throw emiErr;

  const { error: payErr } = await db.from('emi_payments').insert({
    ID: userId, 'EMI ID': emiId, 'EMI #': '1', 'Bill Date': startDate, 'Due Date': paidDate,
    'Paid Date': paidDate, 'Payment Mode': paymentMode, Amount: emiAmt, Status: 'Paid', Remarks: remarks || '-',
  });
  if (payErr) throw payErr;

  const { error: expErr } = await db.from('expenses').insert({
    ID: userId, Date: paidDate, Category: MIRROR_EXPENSE_CATEGORY, Description: `EM${paidN} - ${description}`,
    'Payment Mode': paymentMode, 'Expense Amount': emiAmt, Remarks: remarks || '-', 'EMI ID': emiId,
  });
  if (expErr) throw expErr;

  return { success: true, emiId };
}

// EMI that was already partway through before you started tracking it here.
// No payment history is fabricated — only the running totals are recorded.
async function addProgressEMI(p) {
  const {
    userId, category, description, totalAmount, emiAmount,
    totalEMIs, paidEMIs, startDate, billGenerateDate, nextBillDate, nextDueDate,
    paymentMode, remarks, status,
  } = p;
  if (!userId || !description || !totalAmount || !emiAmount || !totalEMIs) {
    return { success: false, error: 'Missing required fields' };
  }
  const emiId = genId('E');
  const totalN = toNum(totalEMIs);
  const paidN = toNum(paidEMIs);
  const remainingN = totalN - paidN;

  const { error } = await db.from('emi').insert({
    ID: userId, 'EMI ID': emiId, 'Start Date': startDate, Category: category,
    Description: description, 'Total Amount': toNum(totalAmount), 'EMI Amount': toNum(emiAmount),
    'Total EMIs': totalN, 'Paid EMIs': paidN, 'Remaining EMIs': remainingN,
    'Bill Generate Date': String(billGenerateDate), 'Next Bill Date': nextBillDate,
    'Next Due Date': nextDueDate, 'Payment Mode': paymentMode,
    Status: status || (remainingN <= 0 ? 'Closed' : 'Active'), Remarks: remarks || '-',
  });
  if (error) throw error;
  return { success: true, emiId };
}

async function editEMI(p) {
  const { userId, emiId, description, category, totalAmount, emiAmount, totalEMIs, paymentMode, remarks } = p;
  if (!userId || !emiId || !description || !totalAmount || !emiAmount || !totalEMIs) {
    return { success: false, error: 'Missing required fields' };
  }
  const { data: emi, error: findErr } = await db
    .from('emi').select('*').eq('ID', userId).eq('EMI ID', emiId).maybeSingle();
  if (findErr) throw findErr;
  if (!emi) return { success: false, error: 'EMI not found' };

  const paidN = toNum(emi['Paid EMIs']);
  const newTotalN = toNum(totalEMIs);
  if (newTotalN < paidN) return { success: false, error: `Total EMIs can't be less than ${paidN} already paid` };
  const newRemainingN = newTotalN - paidN;
  const newStatus = newRemainingN <= 0 ? 'Closed' : 'Active';

  // Only metadata + forward-looking totals change here — Start Date, Bill
  // Generate Date, Next Bill/Due Date and Paid EMIs (the schedule/progress)
  // are left untouched so past payment history stays accurate.
  const { error: updErr } = await db.from('emi')
    .update({
      Category: category, Description: description,
      'Total Amount': toNum(totalAmount), 'EMI Amount': toNum(emiAmount),
      'Total EMIs': newTotalN, 'Remaining EMIs': newRemainingN, Status: newStatus,
      'Payment Mode': paymentMode, Remarks: remarks || '-',
    })
    .eq('ID', userId).eq('EMI ID', emiId);
  if (updErr) throw updErr;

  return { success: true };
}

async function payEMI(p) {
  const { userId, emiId, paidDate, paymentMode, remarks } = p;
  if (!userId || !emiId || !paidDate) return { success: false, error: 'Missing required fields' };

  const { data: emi, error: findErr } = await db
    .from('emi').select('*').eq('ID', userId).eq('EMI ID', emiId).maybeSingle();
  if (findErr) throw findErr;
  if (!emi) return { success: false, error: 'EMI not found' };

  const totalN = toNum(emi['Total EMIs']);
  const paidN = toNum(emi['Paid EMIs']) + 1;
  const remainingN = totalN - paidN;
  const newStatus = remainingN <= 0 ? 'Closed' : 'Active';
  const billDay = toNum(emi['Bill Generate Date']);

  const oldNextBill = parseDMY(emi['Next Bill Date']) || new Date();
  const oldNextDue = parseDMY(emi['Next Due Date']) || oldNextBill;
  const dueOffsetDays = Math.round((oldNextDue - oldNextBill) / 86400000);
  const newNextBill = addMonthsOnDay(oldNextBill, 1, billDay);
  const newNextDue = new Date(newNextBill.getTime() + dueOffsetDays * 86400000);

  const { error: updErr } = await db.from('emi')
    .update({
      'Paid EMIs': paidN, 'Remaining EMIs': remainingN, Status: newStatus,
      'Next Bill Date': formatDMY(newNextBill), 'Next Due Date': formatDMY(newNextDue),
    })
    .eq('ID', userId).eq('EMI ID', emiId);
  if (updErr) throw updErr;

  const { error: payErr } = await db.from('emi_payments').insert({
    ID: userId, 'EMI ID': emiId, 'EMI #': String(paidN),
    'Bill Date': emi['Next Bill Date'], 'Due Date': emi['Next Due Date'], 'Paid Date': paidDate,
    'Payment Mode': paymentMode, Amount: toNum(emi['EMI Amount']), Status: 'Paid', Remarks: remarks || '-',
  });
  if (payErr) throw payErr;

  const { error: expErr } = await db.from('expenses').insert({
    ID: userId, Date: paidDate, Category: MIRROR_EXPENSE_CATEGORY, Description: `EM${paidN} - ${emi['Description']}`,
    'Payment Mode': paymentMode, 'Expense Amount': toNum(emi['EMI Amount']), Remarks: remarks || '-', 'EMI ID': emiId,
  });
  if (expErr) throw expErr;

  return { success: true, newStatus };
}

async function markEMIMissed(p) {
  const { userId, emiId } = p;
  if (!userId || !emiId) return { success: false, error: 'Missing required fields' };

  const { data: emi, error: findErr } = await db
    .from('emi').select('*').eq('ID', userId).eq('EMI ID', emiId).maybeSingle();
  if (findErr) throw findErr;
  if (!emi) return { success: false, error: 'EMI not found' };

  const totalN = toNum(emi['Total EMIs']);
  const paidN = toNum(emi['Paid EMIs']) + 1; // counts against the schedule, just unpaid
  const remainingN = totalN - paidN;
  const newStatus = remainingN <= 0 ? 'Closed' : 'Active';
  const billDay = toNum(emi['Bill Generate Date']);

  const oldNextBill = parseDMY(emi['Next Bill Date']) || new Date();
  const oldNextDue = parseDMY(emi['Next Due Date']) || oldNextBill;
  const dueOffsetDays = Math.round((oldNextDue - oldNextBill) / 86400000);
  const newNextBill = addMonthsOnDay(oldNextBill, 1, billDay);
  const newNextDue = new Date(newNextBill.getTime() + dueOffsetDays * 86400000);

  const { error: updErr } = await db.from('emi')
    .update({
      'Paid EMIs': paidN, 'Remaining EMIs': remainingN, Status: newStatus,
      'Next Bill Date': formatDMY(newNextBill), 'Next Due Date': formatDMY(newNextDue),
    })
    .eq('ID', userId).eq('EMI ID', emiId);
  if (updErr) throw updErr;

  const { error: payErr } = await db.from('emi_payments').insert({
    ID: userId, 'EMI ID': emiId, 'EMI #': String(paidN),
    'Bill Date': emi['Next Bill Date'], 'Due Date': emi['Next Due Date'], 'Paid Date': '-',
    'Payment Mode': '-', Amount: 0, Status: 'Missed', Remarks: '-',
  });
  if (payErr) throw payErr;

  // No expense recorded — nothing was actually paid.
  return { success: true };
}

async function deleteEMIById(p) {
  const { userId, emiId } = p;
  if (!userId || !emiId) return { success: false, error: 'Missing required fields' };
  const [a, b, c] = await Promise.all([
    db.from('emi').delete().eq('ID', userId).eq('EMI ID', emiId),
    db.from('emi_payments').delete().eq('ID', userId).eq('EMI ID', emiId),
    db.from('expenses').delete().eq('ID', userId).eq('EMI ID', emiId),
  ]);
  for (const r of [a, b, c]) if (r.error) throw r.error;
  return { success: true };
}

// ══════════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════════
async function saveConfig(p) {
  const {
    userId, expenseCustom, expenseUnchecked, incomeCustom, incomeUnchecked,
    loanCustom, loanUnchecked, emiCustom, emiUnchecked,
  } = p;
  if (!userId) return { success: false, error: 'userId required' };

  const lists = {
    expense:  { custom: expenseCustom, unchecked: expenseUnchecked },
    income:   { custom: incomeCustom,  unchecked: incomeUnchecked },
    loan:     { custom: loanCustom,    unchecked: loanUnchecked },
    emi:      { custom: emiCustom,     unchecked: emiUnchecked },
  };

  for (const type of Object.keys(lists)) {
    const customArr    = (lists[type].custom || '').split(',').filter(Boolean);
    const uncheckedArr = (lists[type].unchecked || '').split(',').filter(Boolean);
    await replaceConfigRows(userId, customTypeName(type), customArr);
    await replaceConfigRows(userId, uncheckedTypeName(type), uncheckedArr);
  }

  return { success: true };
}

// ══════════════════════════════════════════════════════════════
// BANK ACCOUNTS
// ══════════════════════════════════════════════════════════════
async function addAccount({ userId, name, opening }) {
  if (!userId || !name || !String(name).trim()) {
    return { success: false, error: 'Account name required' };
  }
  const { error } = await db.from('bank_accounts').insert({
    ID: userId,
    'Account Name': String(name).trim(),
    'Opening Balance': toNum(opening),
  });
  if (error) {
    if (error.code === '23505') return { success: false, error: 'An account with that name already exists' };
    throw error;
  }
  return { success: true };
}

async function editAccount({ userId, rowId, name, opening }) {
  if (!userId || !rowId || !name || !String(name).trim()) {
    return { success: false, error: 'Missing required fields' };
  }
  const oldRow = await db.from('bank_accounts')
    .select('*').eq('ID', userId).eq('row_id', rowId).maybeSingle();
  if (oldRow.error) throw oldRow.error;
  if (!oldRow.data) return { success: false, error: 'Account not found' };

  const newName = String(name).trim();
  const oldName = oldRow.data['Account Name'];

  const { error } = await db.from('bank_accounts')
    .update({ 'Account Name': newName, 'Opening Balance': toNum(opening) })
    .eq('ID', userId).eq('row_id', rowId);
  if (error) {
    if (error.code === '23505') return { success: false, error: 'An account with that name already exists' };
    throw error;
  }

  // Transactions store the account by name, so a rename has to follow through
  if (newName !== oldName) {
    await db.from('expenses').update({ Account: newName }).eq('ID', userId).eq('Account', oldName);
    await db.from('income').update({ Account: newName }).eq('ID', userId).eq('Account', oldName);
  }
  return { success: true };
}

async function deleteAccount({ userId, rowId }) {
  if (!userId || !rowId) return { success: false, error: 'Missing required fields' };
  const row = await db.from('bank_accounts')
    .select('*').eq('ID', userId).eq('row_id', rowId).maybeSingle();
  if (row.error) throw row.error;
  if (!row.data) return { success: false, error: 'Account not found' };

  const name = row.data['Account Name'];
  const { error } = await db.from('bank_accounts')
    .delete().eq('ID', userId).eq('row_id', rowId);
  if (error) throw error;

  // Transactions are kept — they just fall back to unassigned
  await db.from('expenses').update({ Account: null }).eq('ID', userId).eq('Account', name);
  await db.from('income').update({ Account: null }).eq('ID', userId).eq('Account', name);
  return { success: true };
}

// ══════════════════════════════════════════════════════════════
// IMPORT / CLEAR
// ══════════════════════════════════════════════════════════════
const IMPORT_TABLES = {
  expenses:    'expenses',
  income:      'income',
  loans:       'loan',
  emis:        'emi',
  emiPayments: 'emi_payments',
  accounts:    'bank_accounts',
};

// Strips anything the client shouldn't be able to set, and forces the row to
// belong to the importing user so a doctored file can't write to someone else.
function sanitiseRows(rows, userId) {
  if (!Array.isArray(rows)) return [];
  return rows.map(r => {
    const out = {};
    Object.keys(r || {}).forEach(k => {
      if (k === 'row_id' || k === 'id' || k === '_rowIndex' || k.startsWith('_')) return;
      out[k] = r[k];
    });
    out.ID = userId;
    return out;
  }).filter(r => Object.keys(r).length > 1);
}

async function importData({ userId, payload, mode, confirm, _auth }) {
  if (!userId || !payload) return { success: false, error: 'Missing data to import' };

  // Replacing everything is destructive, so it needs the password
  if (mode === 'replace') {
    if (!(await verifyOwner(_auth))) return { success: false, error: 'Not signed in' };
    if (confirm !== 'REPLACE') {
      return { success: false, error: 'Confirmation text did not match' };
    }
    await wipeUser(userId);
  }

  const counts = {};
  for (const [key, table] of Object.entries(IMPORT_TABLES)) {
    const rows = sanitiseRows(payload[key], userId);
    if (!rows.length) { counts[key] = 0; continue; }
    // Insert in chunks so one oversized request doesn't fail the whole import
    let done = 0;
    for (let i = 0; i < rows.length; i += 250) {
      const slice = rows.slice(i, i + 250);
      const { error } = await db.from(table).insert(slice);
      if (error) return { success: false, error: `${key}: ${error.message}`, imported: counts };
      done += slice.length;
    }
    counts[key] = done;
  }

  if (payload.config && typeof payload.config === 'object') {
    await db.from('personalised_configuration').delete().eq('ID', userId);
    const row = { ID: userId };
    Object.keys(payload.config).forEach(k => { if (/^C\d+$/.test(k)) row[k] = payload.config[k]; });
    if (Object.keys(row).length > 1) await db.from('personalised_configuration').insert(row);
  }

  return { success: true, counts };
}

// Destructive actions used to re-check a stored password. Credentials now live
// in Supabase Auth, so the guard is the caller's own verified session plus an
// explicit typed confirmation from the UI.
async function verifyOwner(auth) {
  return !!(auth && auth.userId);
}

async function wipeUser(userId) {
  // emi_payments first — it references EMIs
  const order = ['emi_payments', 'emi', 'loan', 'expenses', 'income',
                 'bank_accounts', 'personalised_configuration'];
  for (const table of order) {
    const { error } = await db.from(table).delete().eq('ID', userId);
    if (error && error.code !== '42P01') throw error;   // ignore tables that don't exist
  }
}

async function clearData({ userId, confirm, _auth }) {
  if (!(await verifyOwner(_auth))) return { success: false, error: 'Not signed in' };
  if (confirm !== 'DELETE') return { success: false, error: 'Confirmation text did not match' };
  await wipeUser(userId);
  return { success: true };
}

// ══════════════════════════════════════════════════════════════
// USER SETTINGS
// ══════════════════════════════════════════════════════════════
const ALLOWED_SETTINGS = [
  'theme', 'accent', 'hideBalance', 'decimals', 'haptics',
  'carryForward', 'budget', 'catBudgets', 'defaultAccount', 'lastCat'
];

async function saveSettings({ userId, settings }) {
  if (!userId) return { success: false, error: 'Not signed in' };
  if (!settings || typeof settings !== 'object') {
    return { success: false, error: 'No settings provided' };
  }
  // Only persist keys we know about, so a stray client can't bloat the row
  const clean = {};
  ALLOWED_SETTINGS.forEach(k => { if (settings[k] !== undefined) clean[k] = settings[k]; });

  const { error } = await db
    .from('user_settings')
    .upsert({ ID: userId, Settings: clean }, { onConflict: 'ID' });
  if (error) {
    if (error.code === '42P01') {
      return { success: false, error: 'Settings table missing — run the migration' };
    }
    throw error;
  }
  return { success: true };
}

// ══════════════════════════════════════════════════════════════
// ACCOUNT DELETION
//
// Irreversible. Removes every wallet row, the profile row, the saved
// preferences, and finally the Supabase Auth account itself.
// ══════════════════════════════════════════════════════════════
async function deleteMyAccount({ userId, confirm, _auth }) {
  if (!_auth || !_auth.authId) return { success: false, error: 'Not signed in' };
  if (confirm !== 'DELETE MY ACCOUNT') {
    return { success: false, error: 'Confirmation text did not match' };
  }

  // 1. Every transactional table
  await wipeUser(userId);

  // 2. Preferences (deliberately not part of wipeUser, which "Clear data" uses)
  const { error: setErr } = await db.from('user_settings').delete().eq('ID', userId);
  if (setErr && setErr.code !== '42P01') throw setErr;

  // 3. The profile row
  const { error: userErr } = await db.from('users').delete().eq('ID', userId);
  if (userErr) throw userErr;

  // 4. The login itself. Done last: if anything above fails we stop, rather
  //    than leaving orphaned data behind an account that can no longer sign in.
  const { error: authErr } = await db.auth.admin.deleteUser(_auth.authId);
  if (authErr) {
    return {
      success: false,
      error: 'Your data was deleted but the login could not be removed. Contact support.',
    };
  }
  return { success: true };
}
