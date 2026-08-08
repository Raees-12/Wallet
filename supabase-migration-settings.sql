-- ════════════════════════════════════════════════════════════════
-- Wallet — User Settings
-- Run this in the Supabase SQL editor (Database → SQL Editor → New query).
-- Safe to run more than once.
--
-- One row per user holding every preference as JSON. A single JSONB column
-- rather than one column per setting, so adding a new preference later needs
-- no migration at all — the app just starts writing a new key.
-- ════════════════════════════════════════════════════════════════

create table if not exists public.user_settings (
  "ID"         text        primary key,
  "Settings"   jsonb       not null default '{}'::jsonb,
  "Updated At" timestamptz not null default now()
);

-- Keeps "Updated At" honest without the app having to remember
create or replace function public.touch_user_settings()
returns trigger as $$
begin
  new."Updated At" = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists user_settings_touch on public.user_settings;
create trigger user_settings_touch
  before update on public.user_settings
  for each row execute function public.touch_user_settings();

-- What ends up in "Settings":
--   theme          'light' | 'dark' | 'amoled' | 'glass'
--   accent         hex colour string
--   hideBalance    start the dashboard masked
--   decimals       show paise
--   haptics        vibrate on long press
--   carryForward   roll last month's leftover into this month
--   budget         overall monthly limit
--   catBudgets     { "Food": 5000, ... }
--   defaultAccount account preselected on the dashboard
--
-- Deliberately NOT stored here (these are per-device, not per-user):
--   the list of accounts signed in on this phone
--   which notifications have been read
