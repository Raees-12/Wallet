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
 */
async function authenticate(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return { ok: false, status: 401, error: 'Not signed in' };

  const { data, error } = await supabaseAuth.auth.getUser(token);
  if (error || !data || !data.user) {
    return { ok: false, status: 401, error: 'Session expired — please sign in again' };
  }

  const user = data.user;
  const row = await resolveUserRow(user);
  return {
    ok: true,
    authId: user.id,
    walletId: row['ID'],
    email: user.email || row['Mail'] || '',
    createdAt: user.created_at,
    profile: toProfile(row),
  };
}

function toProfile(row) {
  const first = (row['First Name'] || '').trim();
  const last  = (row['Last Name'] || '').trim();
  return {
    id: row['ID'],
    firstName: first,
    lastName: last,
    fullName: [first, last].filter(Boolean).join(' '),
    mobile: row['Mobile'] || '',
    email: row['Mail'] || '',
  };
}

/**
 * Finds — or creates — the `users` row behind an authenticated account.
 *
 * Existing accounts keep their original text ID so none of their wallet rows
 * need rewriting; they're claimed on first sign-in by matching email. Everyone
 * else gets a fresh row keyed by their auth UUID.
 */
async function resolveUserRow(user) {
  // 1. Already linked
  const { data: linked, error: linkErr } = await supabaseAdmin
    .from('users').select('*').eq('Auth ID', user.id).maybeSingle();
  if (linkErr) throw linkErr;
  if (linked) return linked;

  // 2. A pre-existing account with the same email — adopt it
  if (user.email) {
    const { data: legacy } = await supabaseAdmin
      .from('users').select('*').ilike('Mail', user.email).maybeSingle();
    if (legacy && !legacy['Auth ID']) {
      const { data: claimed, error } = await supabaseAdmin
        .from('users')
        .update({ 'Auth ID': user.id, Mail: user.email })
        .eq('ID', legacy['ID'])
        .is('Auth ID', null)          // only if nobody claimed it in the meantime
        .select()
        .maybeSingle();
      if (!error && claimed) return claimed;
    }
  }

  // 3. Brand new account
  const { data: created, error: insErr } = await supabaseAdmin
    .from('users')
    .insert({
      ID: user.id,
      'Auth ID': user.id,
      Mail: user.email || null,
      'First Name': guessFirstName(user),
    })
    .select()
    .maybeSingle();

  if (insErr) {
    // A concurrent first request may have won the race — re-read rather than fail
    const { data: again } = await supabaseAdmin
      .from('users').select('*').eq('Auth ID', user.id).maybeSingle();
    if (again) return again;
    throw insErr;
  }
  return created;
}

function guessFirstName(user) {
  const meta = user.user_metadata || {};
  if (meta.first_name) return meta.first_name;
  if (meta.full_name)  return String(meta.full_name).split(' ')[0];
  return user.email ? user.email.split('@')[0] : 'You';
}

/** Updates only the profile fields a user is allowed to change. */
async function updateProfile(walletId, fields) {
  const patch = {};
  if (fields.firstName !== undefined) patch['First Name'] = String(fields.firstName).trim() || null;
  if (fields.lastName  !== undefined) patch['Last Name']  = String(fields.lastName).trim()  || null;
  if (fields.mobile    !== undefined) patch['Mobile']     = String(fields.mobile).trim()    || null;
  if (!Object.keys(patch).length) return { success: false, error: 'Nothing to update' };

  const { data, error } = await supabaseAdmin
    .from('users').update(patch).eq('ID', walletId).select().maybeSingle();
  if (error) throw error;
  return { success: true, profile: toProfile(data) };
}

module.exports = { authenticate, updateProfile, toProfile };
