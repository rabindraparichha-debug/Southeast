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
 * How to find the caller's IP behind the platform's proxies (D-187):
 *   - Cloudflare's cf-connecting-ip first: Cloudflare sets it and overwrites any value the caller sent.
 *   - Then X-Forwarded-For. Each proxy appends the address it saw, so only entries added by our own
 *     proxies can be trusted. PUBLIC_FORMS_XFF_HOPS=N takes the N-th entry from the right (1 = the
 *     address the last proxy saw); set it once the hosted header chain is known.
 *   - Unset: the left-most entry (what the caller claims, so it can be forged and the per-IP limits
 *     can be dodged; the per-phone, per-lead and overall limits and the CAPTCHA still apply), then
 *     X-Real-IP.
 */
export type IpConfig = { xffHops: number | null };

export function loadIpConfig(env: Env): IpConfig {
  const raw = env('PUBLIC_FORMS_XFF_HOPS')?.trim();
  const n = raw && /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
  return { xffHops: Number.isInteger(n) && n >= 1 && n <= 10 ? n : null };
}

/** The caller's IP for rate limits (see IpConfig), or null when no usable header is present. */
export function clientIp(headers: Headers, cfg: IpConfig = { xffHops: null }): string | null {
  const valid = (v: string | undefined) => {
    const ip = v?.trim();
    return ip && ip.length <= 64 && /^[0-9a-fA-F:.]+$/.test(ip) ? ip : null;
  };
  const cf = valid(headers.get('cf-connecting-ip')?.split(',')[0]);
  if (cf) return cf;
  const xff = (headers.get('x-forwarded-for') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (cfg.xffHops !== null) {
    // Only what our own proxies appended; a chain shorter than expected has no trustworthy entry.
    return xff.length >= cfg.xffHops ? valid(xff[xff.length - cfg.xffHops]) : null;
  }
  return valid(xff[0]) ?? valid(headers.get('x-real-ip') ?? undefined);
}
