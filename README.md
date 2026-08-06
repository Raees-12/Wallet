# Wallet — Vercel + Supabase

## Project structure
```
index.html, app.js, style.css, manifest.json, sw.js, 404.html, Assets/   → frontend (static)
api/wallet.js                                                            → backend (Vercel serverless function)
lib/helpers.js, lib/supabaseAdmin.js                                     → backend helpers
supabase-migration.sql                                                   → one-time DB setup
```

## One-time setup

**1. Database.** In Supabase → SQL Editor, run `supabase-migration.sql`. It adds
`"Loan ID"` / `"EMI ID"` link columns to `expenses`/`income` so deleting a loan
or EMI can clean up the matching mirrored rows. Safe to re-run.

**2. Deploy.** This folder deploys to Vercel as-is — static frontend + `/api`
folder, zero config needed. Either run `vercel` from this folder, or connect
the repo in the Vercel dashboard.

**3. Environment variables** (Vercel → Project → Settings → Environment Variables):
- `SUPABASE_URL` → your project URL
- `SUPABASE_SERVICE_ROLE_KEY` → Supabase → Project Settings → API → service_role key.
  Server-side only — never put this in `app.js` or any frontend file.

Redeploy after adding env vars.

**4. Frontend hosted elsewhere?** If the API is on Vercel but the frontend is
hosted somewhere else, change line 1 of `app.js`:
```js
const API_URL = '/api/wallet';                              // same-domain (default)
const API_URL = 'https://your-project.vercel.app/api/wallet'; // cross-domain
```
CORS is already open on the API, so cross-domain works.

## How data flows
- **Expenses/Income**: plain rows, no special logic.
- **Loans**: adding a loan (`Lent`/`Borrowed`) also creates a mirrored
  Expense (lending money out) or Income (borrowing money in) row, tagged with
  `"Loan ID"`, so your dashboard balance stays accurate. Repaying/collecting
  does the reverse. Deleting a loan removes all three (loan + mirrored
  expense/income) together. Mirror category: `"EMIs & Loans"` for expenses,
  `"Loan"` for income — change `MIRROR_EXPENSE_CATEGORY` /
  `MIRROR_INCOME_CATEGORY` at the top of `api/wallet.js` to rename.
- **EMIs**: paying an EMI creates an `emi_payments` row *and* a mirrored
  Expense row. Marking one **missed** does not (nothing was actually paid).
  Deleting an EMI removes the EMI, its payment history, and its mirrored
  expenses together.
- **Categories/config** (`personalised_configuration`): each category type
  (e.g. "Expense Type Custom") can span multiple rows, values packed 10 per
  row across `C1`–`C10`. Saving replaces all rows for that type with the
  current list; reading flattens every row for that type back into one list.
- **IDs**: Loan ID / EMI ID are generated as a letter + timestamp + random
  chars (e.g. `LM1A2B3XYZ`) — unique without extra lookups.

## Notes
- Login compares passwords in plain text, matching your original setup. Fine
  for a personal single-user app; revisit if this is ever shared or exposed
  more widely.
- Service worker (`sw.js`) and manifest are scoped to the site root — this
  matters if you ever move the app to a subfolder again (e.g. GitHub Pages),
  in which case `start_url`/`scope` in `manifest.json`, `BASE` in `sw.js`,
  and the registration path in `index.html` all need to point at that
  subfolder together.
