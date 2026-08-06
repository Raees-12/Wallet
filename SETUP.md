# Wallet — Vercel + Supabase setup

## 1. Run the SQL migration
In Supabase → SQL Editor, run `supabase-migration.sql`. It adds `"Loan ID"` /
`"EMI ID"` link columns to `expenses`/`income`, plus a unique index needed by
config saving. Safe to re-run (uses `if not exists`).

## 2. Deploy to Vercel
This folder is a normal static site (`index.html`, `app.js`, etc.) plus an
`/api` folder — Vercel auto-detects both, no build step needed.

```
npm install       # installs @supabase/supabase-js locally (optional, Vercel does this too)
vercel             # or: connect the repo in the Vercel dashboard
```

## 3. Set environment variables (Vercel → Project → Settings → Environment Variables)
- `SUPABASE_URL` → `https://iyrenwackbpdlxxoiqna.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY` → your service role key (Supabase → Project Settings → API).
  **Never** put this in `app.js` or any frontend file — it bypasses Row Level Security.

Redeploy after adding env vars so the function picks them up.

## 4. If you host the frontend somewhere else (e.g. GitHub Pages) and only the API on Vercel
Change line 1 of `app.js` from:
```js
const API_URL = '/api/wallet';
```
to your deployed Vercel URL:
```js
const API_URL = 'https://your-project.vercel.app/api/wallet';
```
The API already sends permissive CORS headers, so this works cross-origin.

## What I had to assume (Apps Script source wasn't available)
Since the original Google Apps Script only existed as an empty stub, all
backend logic below was reconstructed from how `app.js` calls and consumes
each action. Flagging these so you can tell me if any should behave
differently:

- **Loan/EMI money is mirrored into Expenses/Income** (per your own delete
  confirmation text mentioning "Expenses and Income sheets"): lending money
  or paying an EMI creates an Expense row; borrowing or collecting a loan
  repayment creates an Income row. This keeps your dashboard balance
  accurate. Mirrored rows use category **"EMIs & Loans"** (expenses) or
  **"Loan"** (income) — change `MIRROR_EXPENSE_CATEGORY` /
  `MIRROR_INCOME_CATEGORY` at the top of `api/wallet.js` if you'd prefer
  something else.
- **Marking an EMI missed does not create an expense** (matches the
  in-app confirmation text: "No expense will be recorded").
- **Loan ID / EMI ID format**: generated as `L`/`E` + timestamp + random
  chars (e.g. `LM1A2B3XYZ`) — not sequential, but guaranteed unique without
  extra DB round-trips.
- **New EMI (`addEMI`) due date**: since that form doesn't collect a
  separate due-day, Next Due Date = Next Bill Date for the first cycle.
  From the second payment on, `payEMI` preserves whatever gap you set
  between bill/due dates in an in-progress EMI (`addProgressEMI`), so if
  you add in-progress EMIs with a due-date gap, that gap is carried
  forward automatically on every future payment.
- **`personalised_configuration`**: one row per user
  (`"Configuration Type" = 'categories'`), with `C1`–`C8` holding
  expense/income/loan/EMI custom + unchecked lists respectively. `C9`/`C10`
  are unused.

Test each flow (add/edit/delete expense, income, loan, repay, EMI add/pay/miss/delete,
save config) against your real data before relying on this day to day —
worth double-checking the loan/EMI mirroring behavior in particular matches
what you expect for your balance numbers.
