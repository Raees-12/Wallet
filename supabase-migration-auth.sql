-- ════════════════════════════════════════════════════════════════
-- Wallet — Supabase Auth
-- Run in Supabase → SQL Editor. Safe to run more than once.
-- Nothing here deletes or rewrites existing wallet data.
-- ════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────
-- 1. PROFILES
-- Bridges a Supabase auth user to the text "ID" that every wallet
-- table is already keyed by. Existing accounts keep their original
-- ID, so no rows need migrating; new accounts use their UUID.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id         uuid        primary key references auth.users(id) on delete cascade,
  wallet_id  text        not null unique,
  email      text,
  username   text,
  created_at timestamptz not null default now()
);

create index if not exists profiles_wallet_id_idx on public.profiles (wallet_id);

-- ─────────────────────────────────────────────────────────────
-- 2. ROW LEVEL SECURITY
--
-- All wallet reads and writes go through the serverless API, which
-- uses the service-role key and verifies the caller's JWT before
-- touching anything. Service role bypasses RLS by design.
--
-- Enabling RLS with no permissive policy therefore means: the API
-- can act (after it has authenticated you), and a browser holding
-- only the anon key can read nothing at all — even if someone finds
-- the anon key, which is public by design.
-- ─────────────────────────────────────────────────────────────
alter table public.expenses                    enable row level security;
alter table public.income                      enable row level security;
alter table public.loan                        enable row level security;
alter table public.emi                         enable row level security;
alter table public.emi_payments                enable row level security;
alter table public.personalised_configuration  enable row level security;
alter table public.profiles                    enable row level security;

-- These two came from earlier migrations; guard in case they aren't present yet
do $$ begin
  if to_regclass('public.bank_accounts') is not null then
    execute 'alter table public.bank_accounts enable row level security';
  end if;
  if to_regclass('public.user_settings') is not null then
    execute 'alter table public.user_settings enable row level security';
  end if;
end $$;

-- A user may read their own profile row directly (handy for debugging and for
-- any future direct-from-browser query). They may not change wallet_id.
drop policy if exists "profiles readable by owner" on public.profiles;
create policy "profiles readable by owner"
  on public.profiles for select
  using (auth.uid() = id);

-- ─────────────────────────────────────────────────────────────
-- 3. OPTIONAL — direct browser access to wallet tables
--
-- Only needed if you later want the frontend to query Supabase
-- directly instead of going through /api/wallet. Left commented
-- out because the current architecture doesn't need it.
--
-- create or replace function public.current_wallet_id()
-- returns text language sql stable security definer as $$
--   select wallet_id from public.profiles where id = auth.uid()
-- $$;
--
-- create policy "own expenses" on public.expenses
--   for all using ("ID" = public.current_wallet_id())
--   with check ("ID" = public.current_wallet_id());
-- (repeat per table)

-- ─────────────────────────────────────────────────────────────
-- 4. LEGACY ACCOUNT LINKING
--
-- Existing users are claimed automatically on first sign-in when the
-- email on their old `users` row matches their Supabase email.
--
-- Check which of your old accounts have a usable email:
--   select "ID", "Username", "Mail" from public.users;
--
-- If an old account has no email or a different one, link it by hand
-- AFTER that person has signed in once with Supabase Auth:
--
--   update public.profiles
--      set wallet_id = 'THEIR_OLD_TEXT_ID'
--    where email = 'their@email.com';
--
-- Do this before they enter any new data, otherwise the rows created
-- under their UUID would be orphaned by the change.
--
-- The old `users` table is left untouched. Once every account is
-- linked and verified you can drop it:
--   -- drop table public.users;
-- ─────────────────────────────────────────────────────────────
