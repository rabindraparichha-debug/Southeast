// Build-time check for the legal pages (D-142). Plain JavaScript so next.config.ts can import it.
//
// A production build that points at a hosted Supabase project must carry the operator's legal name
// and the grievance contact (India's DPDP Act needs a reachable grievance officer). Local builds
// (Supabase on localhost or a LAN address) are not checked, so CI and developers keep building.

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|::1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|kong|host\.docker\.internal|[a-z0-9-]+\.local)$/i;

/** True when the web app is built against a local Supabase stack. */
export function isLocalSupabase(url) {
  if (!url) return true; // env.ts refuses to build without a URL anyway
  try {
    return LOCAL_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** A value copied from an example file, or a bracketed placeholder, does not count. */
export function isPlaceholder(value) {
  const v = (value ?? '').trim();
  return !v || /\[|\]|\(name\)|example\.(in|com|org)|^x+$|todo|changeme/i.test(v);
}

/** Missing legal settings for a production build against `env`, as a list of variable names. */
export function missingLegalEnv(env) {
  if (isLocalSupabase(env.NEXT_PUBLIC_SUPABASE_URL)) return [];
  return ['NEXT_PUBLIC_OPERATOR_NAME', 'NEXT_PUBLIC_GRIEVANCE_CONTACT'].filter((k) => isPlaceholder(env[k]));
}
