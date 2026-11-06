// Cloudflare Turnstile (CAPTCHA) for the public forms, and the caller's IP for rate limits.
// No external imports: runs in Deno and in the Node test suite.
//
// TURNSTILE_SECRET_KEY set: every lead and vendor form submission needs a valid Turnstile token.
// Unset: allowed only on a local stack (PLATFORM_ENV, _shared/platform.ts); a hosted project
// without the key refuses the forms (captcha_not_configured) instead of leaving them open.

import { mockAllowed } from './platform.ts';

type Env = (name: string) => string | undefined;

export type CaptchaConfig = { mode: 'off' | 'turnstile'; secret?: string; verifyUrl: string };

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function loadCaptchaConfig(env: Env): CaptchaConfig {
  const secret = env('TURNSTILE_SECRET_KEY')?.trim() || undefined;
  if (secret) return { mode: 'turnstile', secret, verifyUrl: env('TURNSTILE_VERIFY_URL')?.trim() || TURNSTILE_VERIFY_URL };
  if (!mockAllowed(env)) {
    throw new Error('captcha_not_configured: set TURNSTILE_SECRET_KEY (public forms need a CAPTCHA outside a local stack)');
  }
  return { mode: 'off', verifyUrl: '' };
}

/** Asks Cloudflare whether the token the browser got from the widget is valid (single use). */
export async function verifyCaptcha(
  cfg: CaptchaConfig,
  token: unknown,
  ip: string | null,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  if (cfg.mode === 'off') return true;
  if (typeof token !== 'string' || !token || token.length > 2048) return false;
  const body = new URLSearchParams({ secret: cfg.secret ?? '', response: token });
  if (ip) body.set('remoteip', ip);
  try {
    const res = await fetchFn(cfg.verifyUrl, { method: 'POST', body });
    const out = (await res.json().catch(() => null)) as { success?: boolean } | null;
    return out?.success === true;
  } catch {
    return false;
  }
}

/**
 * The caller's IP as seen by the Edge runtime: Cloudflare's header first (set by Cloudflare, not
 * the caller), then the first X-Forwarded-For entry, then X-Real-IP.
 * Best effort (a proxy header can be forged), so the database also limits per phone and overall.
 */
export function clientIp(headers: Headers): string | null {
  const pick = (v: string | null) => {
    const ip = v?.split(',')[0]?.trim();
    return ip && ip.length <= 64 && /^[0-9a-fA-F:.]+$/.test(ip) ? ip : null;
  };
  return pick(headers.get('cf-connecting-ip')) ?? pick(headers.get('x-forwarded-for')) ?? pick(headers.get('x-real-ip'));
}
