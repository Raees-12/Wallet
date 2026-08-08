alter table public.expenses
  add column if not exists "Loan ID" text null,
  add column if not exists "EMI ID" text null;

alter table public.income
  add column if not exists "Loan ID" text null;

create index if not exists expenses_loan_id_idx on public.expenses ("Loan ID");
create index if not exists expenses_emi_id_idx on public.expenses ("EMI ID");
create index if not exists income_loan_id_idx on public.income ("Loan ID");
create index if not exists loan_loan_id_idx on public.loan ("Loan ID");
create index if not exists emi_emi_id_idx on public.emi ("EMI ID");
create index if not exists emi_payments_emi_id_idx on public.emi_payments ("EMI ID");
