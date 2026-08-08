// The frontend is a static bundle with no build step, so it can't have Vercel
// env vars inlined at compile time. This endpoint hands the browser the two
// values that are safe to be public: the project URL and the anon key.
//
// The anon key is designed to be exposed — it grants nothing on its own and is
// governed by RLS. The service-role key is never sent here.
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=300');

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    return res.status(500).json({
      error: 'Server is missing SUPABASE_URL or SUPABASE_ANON_KEY',
    });
  }
  return res.status(200).json({ supabaseUrl: url, supabaseAnonKey: anonKey });
};
