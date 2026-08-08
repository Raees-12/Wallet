// All dates in these tables are stored as "DD/MM/YYYY" text, matching the
// format the frontend already sends via fmtDateForSheet().

function parseDMY(s) {
  if (!s) return null;
  const parts = String(s).trim().split('/');
  if (parts.length !== 3) return null;
  const [d, m, y] = parts.map(Number);
  if (!d || !m || !y) return null;
  return new Date(y, m - 1, d);
}

function formatDMY(date) {
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const y = date.getFullYear();
  return `${d}/${m}/${y}`;
}

// Advance a date by `months`, landing on `day` of that month (clamped to the
// last day of the month if it doesn't have that many days, e.g. day=31 in Feb).
function addMonthsOnDay(fromDate, months, day) {
  const base = new Date(fromDate.getFullYear(), fromDate.getMonth() + months, 1);
  const lastDayOfMonth = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
  base.setDate(Math.min(day, lastDayOfMonth));
  return base;
}

// Short, human-scannable, effectively-unique ID: PREFIX + base36 timestamp + 3 random chars.
// e.g. genId('L') -> "LM1A2B3C9F2"
function genId(prefix) {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `${prefix}${ts}${rand}`;
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = { parseDMY, formatDMY, addMonthsOnDay, genId, toNum };
