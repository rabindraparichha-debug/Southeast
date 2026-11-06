// The public website forms (lead form, kitchen pick, vendor sign-up) reach the database only
// through here: a Cloudflare Turnstile check (_shared/turnstile.ts) for the two forms, then the
// RPC as the service role with the caller's IP for the database's rate limits (wave 3).
// Pure logic with injected dependencies, unit-tested in tests/integration/public-forms.test.ts.
import { corsHeaders, json } from '../_shared/http.ts';
import { clientIp, type IpConfig } from '../_shared/turnstile.ts';

type Json = Record<string, unknown>;

/** The arguments each action accepts (anything else is dropped), and whether it needs a CAPTCHA. */
export const ACTIONS: Record<string, { args: string[]; captcha: boolean }> = {
  submit_lead: {
    captcha: true,
    args: ['p_name', 'p_phone', 'p_area', 'p_slots', 'p_diet', 'p_budget_paise', 'p_start', 'p_lat', 'p_lng', 'p_address',
      'p_source', 'p_campaign', 'p_consent', 'p_whatsapp_opt_in', 'p_language'],
  },
  // The lead token from submit_lead (which passed the CAPTCHA) is the proof here; rate limits apply.
  lead_choose: { captcha: false, args: ['p_token', 'p_kitchen'] },
  submit_vendor_application: {
    captcha: true,
    args: ['p_name', 'p_phone', 'p_kitchen_name', 'p_area', 'p_subscribers', 'p_fssai', 'p_source', 'p_campaign', 'p_consent',
      'p_whatsapp_opt_in'],
  },
};

export type PublicFormDeps = {
  /** Checks the Turnstile token (always true when the CAPTCHA is off locally). */
  verifyCaptcha: (token: unknown, ip: string | null) => Promise<boolean>;
  /** Calls the RPC as the service role, passing the caller's IP. */
  rpc: (fn: string, args: Json, ip: string | null) => Promise<{ data: unknown; error: { message: string } | null }>;
  report?: (e: unknown) => void;
  /** Which X-Forwarded-For entry to trust (PUBLIC_FORMS_XFF_HOPS); default: see clientIp. */
  ip?: IpConfig;
};

/** HTTP status for a database error code. */
export function statusFor(code: string): number {
  if (code === 'rate_limited' || code === 'too_many_requests') return 429;
  if (code === 'feature_disabled') return 404;
  return 400;
}

export async function handlePublicForm(req: Request, deps: PublicFormDeps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const body = (await req.json().catch(() => null)) as { action?: unknown; args?: unknown; captcha_token?: unknown } | null;
  const name = typeof body?.action === 'string' ? body.action : '';
  const action = Object.prototype.hasOwnProperty.call(ACTIONS, name) ? ACTIONS[name] : undefined;
  if (!body || !action || typeof body.args !== 'object' || body.args === null || Array.isArray(body.args)) {
    return json({ error: 'invalid_request' }, 400);
  }
  const given = body.args as Json;
  const args: Json = {};
  for (const k of action.args) if (given[k] !== undefined) args[k] = given[k];

  const ip = clientIp(req.headers, deps.ip);
  if (action.captcha && !(await deps.verifyCaptcha(body.captcha_token, ip))) {
    return json({ error: 'captcha_failed' }, 403);
  }
  try {
    const { data, error } = await deps.rpc(name, args, ip);
    if (error) {
      const code = String(error.message || 'failed');
      return json({ error: code }, statusFor(code));
    }
    return json({ data });
  } catch (e) {
    deps.report?.(e);
    return json({ error: 'failed' }, 500);
  }
}
