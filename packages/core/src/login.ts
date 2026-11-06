// Phone-code login helpers shared by the web and mobile login screens (docs/LOGIN.md, D-126).

export type LoginChannel = 'whatsapp' | 'sms';

/** Seconds before the apps offer "Resend" / "Send code by SMS instead". Hosted max_frequency should not exceed it. */
export const RESEND_SECONDS = 30;

/**
 * NEXT_PUBLIC_LOGIN_CHANNELS / EXPO_PUBLIC_LOGIN_CHANNELS: an ordered list, e.g. "whatsapp,sms".
 * The first is the default; the others are offered as "instead". Unknown values are ignored and an
 * empty list means SMS (what the local stack's test numbers use).
 */
export function parseLoginChannels(raw: string | null | undefined): LoginChannel[] {
  const out: LoginChannel[] = [];
  for (const part of String(raw ?? '').split(',')) {
    const c = part.trim().toLowerCase();
    if ((c === 'whatsapp' || c === 'sms') && !out.includes(c)) out.push(c);
  }
  return out.length > 0 ? out : ['sms'];
}

/** The channel to offer as "instead", if any. */
export function alternateChannel(channels: LoginChannel[], current: LoginChannel): LoginChannel | null {
  return channels.find((c) => c !== current) ?? null;
}

/** Auth's "For security purposes, you can only request this after 37 seconds." → 37. */
export function retryAfterSeconds(message: string | null | undefined): number | null {
  const m = /after (\d+) seconds?/i.exec(message ?? '');
  return m ? Number(m[1]) : null;
}

export type LoginErrorKey =
  | 'invalid_phone'
  | 'over_sms_send_rate_limit'
  | 'over_request_rate_limit'
  | 'sms_send_failed'
  | 'sms_not_configured'
  | 'phone_not_allowed'
  | 'otp_expired'
  | 'signup_disabled'
  | 'phone_provider_disabled'
  | 'network';

/**
 * Supabase Auth errors (error.code, e.g. over_sms_send_rate_limit) and the auth-send-sms hook's
 * errors (which arrive as error.message, e.g. sms_send_failed) → one key the apps translate.
 * Null means "not a login error we know": show the generic text.
 */
export function loginErrorKey(error: { code?: string | null; message?: string | null; status?: number | null } | null | undefined): LoginErrorKey | null {
  if (!error) return null;
  const code = error.code ?? '';
  const msg = error.message ?? '';
  switch (code) {
    case 'over_sms_send_rate_limit':
    case 'over_request_rate_limit':
    case 'sms_send_failed':
    case 'otp_expired':
    case 'phone_provider_disabled':
      return code;
    case 'signup_disabled':
    case 'otp_disabled':
      return 'signup_disabled';
    case 'hook_timeout':
    case 'hook_timeout_after_retry':
      return 'sms_send_failed';
    case 'validation_failed':
      if (/phone/i.test(msg)) return 'invalid_phone';
      break;
  }
  // Hook answers carry our code as the message.
  if (msg === 'sms_send_failed' || msg === 'sms_not_configured' || msg === 'phone_not_allowed') return msg;
  if (/token has expired or is invalid/i.test(msg)) return 'otp_expired';
  if (/you can only request this after/i.test(msg)) return 'over_sms_send_rate_limit';
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(msg)) return 'network';
  // Hook unreachable or misconfigured (Auth reports a 5xx "hook" failure).
  if ((error.status ?? 0) >= 500 && /hook/i.test(msg)) return 'sms_send_failed';
  return null;
}
