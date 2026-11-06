// Which environment the Edge Functions run in. Mock modes (no real payments, no real messages, a
// fixture instead of the AI) are allowed only on a developer's machine, so a hosted project with a
// missing key fails closed instead of pretending to work. No external imports: runs in Deno and in
// the Node test suite.
//
// PLATFORM_ENV (secret): local | staging | production. Unset counts as 'local' only when SUPABASE_URL
// points at a local stack; anywhere else it counts as hosted ('unknown'), and so does 'local' set on a
// project whose SUPABASE_URL is not local.

type Env = (name: string) => string | undefined;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', 'kong', 'host.docker.internal']);

/** True for the URLs a local Supabase stack uses (http://kong:8000 inside the Edge runtime, 127.0.0.1:54321 outside). */
export function isLocalSupabaseUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return LOCAL_HOSTS.has(host) || host.startsWith('127.') || host.startsWith('supabase_kong_');
}

/** 'local', 'staging', 'production' (whatever PLATFORM_ENV says), or 'unknown' when it cannot be trusted. */
export function platformEnv(env: Env): string {
  const declared = (env('PLATFORM_ENV') ?? '').trim().toLowerCase();
  const localUrl = isLocalSupabaseUrl(env('SUPABASE_URL'));
  if (!declared) return localUrl ? 'local' : 'unknown';
  if (declared === 'local' && !localUrl) return 'unknown';
  return declared;
}

/** Mock modes run only locally. */
export function mockAllowed(env: Env): boolean {
  return platformEnv(env) === 'local';
}
