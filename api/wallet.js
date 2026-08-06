const { supabaseAdmin } = require('../lib/supabaseAdmin');
const { parseDMY, formatDMY, addMonthsOnDay, genId, toNum } = require('../lib/helpers');

const db = supabaseAdmin;

// ── shared category used for mirrored expense/income rows created by
//    loan and EMI actions (matches the existing "EMIs & Loans" default
//    expense category so it shows up sensibly in reports/filters) ──
const MIRROR_EXPENSE_CATEGORY = 'EMIs & Loans';
const MIRROR_INCOME_CATEGORY = 'Loan';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const params = req.method === 'GET' ? req.query : (req.body || {});
  const action = params.action;

  try {
    switch (action) {
      case 'login':               return res.json(await login(params));
      case 'getAllData':          return res.json(await getAllData(params));
      case 'addExpense':          return res.json(await addExpense(params));
      case 'addIncome':           return res.json(await addIncome(params));
      case 'addLoan':             return res.json(await addLoan(params));
      case 'repayLoan':           return res.json(await repayLoan(params));
      case 'deleteLoanById':      return res.json(await deleteLoanById(params));
      case 'addEMI':              return res.json(await addEMI(params));
      case 'addProgressEMI':      return res.json(await addProgressEMI(params));
      case 'payEMI':              return res.json(await payEMI(params));
      case 'markEMIMissed':       return res.json(await markEMIMissed(params));
      case 'deleteEMIById':       return res.json(await deleteEMIById(params));
      case 'saveConfig':          return res.json(await saveConfig(params));
      default:
        return res.status(400).json({ success: false, error: `Unknown action: ${action}` });
    }
  } catch (e) {
    console.error(`[${action}] error:`, e);
    return res.status(200).json({ success: false, error: e.message || 'Server error' });
  }
};

// ══════════════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════════════
async function login({ username, password }) {
  if (!username || !password) return { success: false, error: 'Username and password required' };
  const { data, error } = await db
    .from('users')
    .select('*')
    .eq('Username', username)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.Password !== password) {
    return { success: false, error: 'Invalid credentials' };
  }
  return { success: true, user: { id: data.ID, username: data.Username, email: data.Mail } };
}

// ══════════════════════════════════════════════════════════════
// GET ALL DATA
// ══════════════════════════════════════════════════════════════
async function getAllData({ userId }) {
  if (!userId) return { success: false, error: 'userId required' };

  const [expenses, income, loans, emis, emiPayments, cfgRows] = await Promise.all([
    db.from('expenses').select('*').eq('ID', userId),
    db.from('income').select('*').eq('ID', userId),
    db.from('loan').select('*').eq('ID', userId),
    db.from('emi').select('*').eq('ID', userId),
    db.from('emi_payments').select('*').eq('ID', userId),
    db.from('personalised_configuration').select('*').eq('ID', userId).eq('Configuration Type', 'categories').maybeSingle(),
  ]);
  for (const r of [expenses, income, loans, emis, emiPayments]) if (r.error) throw r.error;
  if (cfgRows.error) throw cfgRows.error;

  const c = cfgRows.data || {};
  const config = {
    expenseCustom: c.C1 || '', expenseUnchecked: c.C2 || '',
    incomeCustom: c.C3 || '',  incomeUnchecked: c.C4 || '',
    loanCustom: c.C5 || '',    loanUnchecked: c.C6 || '',
    emiCustom: c.C7 || '',     emiUnchecked: c.C8 || '',
  };

  return {
    success: true,
    expenses: expenses.data || [],
    income: income.data || [],
    loans: loans.data || [],
    loanSummary: buildLoanSummary(loans.data || []),
    emis: emis.data || [],
    emiPayments: emiPayments.data || [],
    config,
  };
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
  const { userId, date, amount, category, description, paymentMode, remarks } = p;
  if (!userId || !amount || !description) return { success: false, error: 'Missing required fields' };
  const { error } = await db.from('expenses').insert({
    ID: userId, Date: date, Category: category, Description: description,
    'Payment Mode': paymentMode, 'Expense Amount': toNum(amount), Remarks: remarks || '-',
  });
  if (error) throw error;
  return { success: true };
}

async function addIncome(p) {
  const { userId, date, amount, category, description, paymentMode, remarks } = p;
  if (!userId || !amount || !description) return { success: false, error: 'Missing required fields' };
  const { error } = await db.from('income').insert({
    ID: userId, Date: date, Category: category, Description: description,
    'Payment Mode': paymentMode, 'Income Amount': toNum(amount), Remarks: remarks || '-',
  });
  if (error) throw error;
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
    // Money leaves your pocket when you lend it out
    const { error } = await db.from('expenses').insert({
      ID: userId, Date: date, Category: MIRROR_EXPENSE_CATEGORY, Description: description,
      'Payment Mode': paymentMode, 'Expense Amount': amt, Remarks: remarks || '-', 'Loan ID': loanId,
    });
    if (error) throw error;
  } else {
    // Money comes in when you borrow it
    const { error } = await db.from('income').insert({
      ID: userId, Date: date, Category: MIRROR_INCOME_CATEGORY, Description: description,
      'Payment Mode': paymentMode, 'Income Amount': amt, Remarks: remarks || '-', 'Loan ID': loanId,
    });
    if (error) throw error;
  }
  return { success: true, loanId };
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
      ID: userId, Date: date, Category: MIRROR_INCOME_CATEGORY, Description: origin['Description'],
      'Payment Mode': paymentMode, 'Income Amount': amt, Remarks: remarks || '-', 'Loan ID': loanId,
    });
    if (error) throw error;
  } else {
    // Repaying a loan you took = money paid out
    const { error } = await db.from('expenses').insert({
      ID: userId, Date: date, Category: MIRROR_EXPENSE_CATEGORY, Description: origin['Description'],
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
    ID: userId, Date: paidDate, Category: MIRROR_EXPENSE_CATEGORY, Description: description,
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
    ID: userId, Date: paidDate, Category: MIRROR_EXPENSE_CATEGORY, Description: emi['Description'],
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

  const row = {
    ID: userId,
    'Configuration Type': 'categories',
    C1: expenseCustom || '', C2: expenseUnchecked || '',
    C3: incomeCustom || '',  C4: incomeUnchecked || '',
    C5: loanCustom || '',    C6: loanUnchecked || '',
    C7: emiCustom || '',     C8: emiUnchecked || '',
  };

  // Requires the unique index on (ID, "Configuration Type") from supabase-migration.sql
  const { error } = await db
    .from('personalised_configuration')
    .upsert(row, { onConflict: 'ID,Configuration Type' });
  if (error) throw error;
  return { success: true };
}
