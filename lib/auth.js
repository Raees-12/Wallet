const { createClient } = require('@supabase/supabase-js');
const { supabaseAdmin } = require('./supabaseAdmin');

const supabaseUrl = process.env.SUPABASE_URL;
const anonKey     = process.env.SUPABASE_ANON_KEY;

// A separate anon client is used purely to validate access tokens. The admin
// client can't do this — it would happily accept its own service-role key.
const supabaseAuth = createClient(supabaseUrl, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/**
 * Verifies the Bearer token on a request and returns the caller's identity.
 *
 * This is the single gate for the whole API. Nothing downstream may take a user
 * id from the request body — it comes from the verified token or not at all.
 *
 * Returns { ok: true, userId, walletId, email, provider, createdAt }
 *      or { ok: false, status, error }
 */
async function authenticate(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    return { ok: false, status: 401, error: 'Not signed in' };
  }

  const { data, error } = await supabaseAuth.auth.getUser(token);
  if (error || !data || !data.user) {
    return { ok: false, status: 401, error: 'Session expired — please sign in again' };
  }

  const user = data.user;
  const walletId = await resolveWalletId(user);
  return {
    ok: true,
    userId: user.id,
    walletId,
    email: user.email || '',
    provider: (user.app_metadata && user.app_metadata.provider) || 'email',
    createdAt: user.created_at,
    username: displayName(user),
  };
}

function displayName(user) {
  const meta = user.user_metadata || {};
  return meta.full_name || meta.name || meta.username ||
         (user.email ? user.email.split('@')[0] : 'User');
}

/**
 * Maps an auth user onto the text "ID" that every wallet table is keyed by.
 *
 * Existing accounts created before Supabase Auth keep their original ID, so no
 * rows have to be rewritten. They're claimed on first sign-in by matching the
 * email on the legacy users row. Everyone else simply uses their UUID.
 */
async function resolveWalletId(user) {
  const { data: profile, error } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .maybeSingle();
  if (error) throw error;
  if (profile) return profile.wallet_id;

  let walletId = user.id;

  // First sign-in: try to adopt a pre-existing wallet with the same email
  if (user.email) {
    const { data: legacy } = await supabaseAdmin
      .from('users')
      .select('*')
      .ilike('Mail', user.email)
      .maybeSingle();
    if (legacy && legacy.ID) {
      // Only adopt it if nobody has claimed it already
      const { data: taken } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('wallet_id', legacy.ID)
        .maybeSingle();
      if (!taken) walletId = String(legacy.ID);
    }
  }

  const { error: insErr } = await supabaseAdmin.from('profiles').insert({
    id: user.id,
    wallet_id: walletId,
    email: user.email || null,
    username: displayName(user),
  });
  // A concurrent first request may have won the race — re-read rather than fail
  if (insErr) {
    const { data: again } = await supabaseAdmin
      .from('profiles').select('*').eq('id', user.id).maybeSingle();
    if (again) return again.wallet_id;
    throw insErr;
  }
  return walletId;
}

module.exports = { authenticate };
