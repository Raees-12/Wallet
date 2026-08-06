-- Run this once in the Supabase SQL editor before deploying.
-- Adds nullable link columns so mirrored Expense/Income rows (created when a
-- loan or EMI is added/repaid/paid) can be found and cleaned up on delete.

alter table public.expenses
  add column if not exists "Loan ID" text null,
  add column if not exists "EMI ID" text null;

alter table public.income
  add column if not exists "Loan ID" text null;

-- One config row per user is expected (ID + Configuration Type).
-- This makes saveConfig's delete-then-insert safe/fast and prevents duplicates.
create unique index if not exists personalised_configuration_user_type_uq
  on public.personalised_configuration ("ID", "Configuration Type");

-- Helpful lookup indexes
create index if not exists expenses_loan_id_idx on public.expenses ("Loan ID");
create index if not exists expenses_emi_id_idx on public.expenses ("EMI ID");
create index if not exists income_loan_id_idx on public.income ("Loan ID");
create index if not exists loan_loan_id_idx on public.loan ("Loan ID");
create index if not exists emi_emi_id_idx on public.emi ("EMI ID");
create index if not exists emi_payments_emi_id_idx on public.emi_payments ("EMI ID");
