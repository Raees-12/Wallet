-- ════════════════════════════════════════════════════════════════
-- Wallet — Bank Accounts
-- Run this in the Supabase SQL editor (Database → SQL Editor → New query).
-- Safe to run more than once: every statement uses IF NOT EXISTS.
-- ════════════════════════════════════════════════════════════════

-- 1. The accounts themselves.
--    "ID" is the wallet user id, matching the convention used by the
--    expenses / income / loan tables.
create table if not exists public.bank_accounts (
  row_id            bigint generated always as identity primary key,
  "ID"              text        not null,
  "Account Name"    text        not null,
  "Opening Balance" numeric     not null default 0,
  "Created At"      timestamptz not null default now()
);

create index if not exists bank_accounts_user_idx
  on public.bank_accounts ("ID");

-- Stop the same person creating two accounts with the same name.
create unique index if not exists bank_accounts_user_name_idx
  on public.bank_accounts ("ID", lower("Account Name"));

-- 2. Tag transactions with the account they belong to.
--    Null / empty means "unassigned" — existing rows stay valid and simply
--    show up under Unassigned in the account filter.
alter table public.expenses
  add column if not exists "Account" text null;

alter table public.income
  add column if not exists "Account" text null;

create index if not exists expenses_account_idx on public.expenses ("Account");
create index if not exists income_account_idx   on public.income   ("Account");

-- 3. Optional: if you want every existing transaction assigned to one
--    starting account, create it first in the app, then run this ONCE with
--    the name you used. Leave it commented out otherwise.
--
-- update public.expenses set "Account" = 'Main Account'
--   where "ID" = 'YOUR_USER_ID' and ("Account" is null or "Account" = '');
-- update public.income   set "Account" = 'Main Account'
--   where "ID" = 'YOUR_USER_ID' and ("Account" is null or "Account" = '');
