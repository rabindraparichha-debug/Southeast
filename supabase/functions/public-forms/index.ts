// Public website forms: lead form, kitchen pick and vendor sign-up (see handler.ts).
// Called from the browser with the anon key (supabase.functions.invoke('public-forms')).
import { json } from '../_shared/http.ts';
import { loadMonitorConfig, reportError } from '../_shared/monitor.ts';
import { loadCaptchaConfig, verifyCaptcha, type CaptchaConfig } from '../_shared/turnstile.ts';
import { handlePublicForm } from './handler.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const env = (k: string) => Deno.env.get(k);
const monitor = loadMonitorConfig(env);

Deno.serve(async (req) => {
  let captcha: CaptchaConfig;
  try {
    captcha = loadCaptchaConfig(env);
  } catch (e) {
    // captcha_not_configured: a hosted project without TURNSTILE_SECRET_KEY keeps the forms closed.
    return json({ error: String((e as Error).message).split(':')[0] }, 503);
  }
  return handlePublicForm(req, {
    verifyCaptcha: (token, ip) => verifyCaptcha(captcha, token, ip),
    rpc: async (fn, args, ip) => {
      // Only the service role can call these functions, so the database trusts this header.
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          ...(ip ? { 'x-tiffin-client-ip': ip } : {}),
        },
        body: JSON.stringify(args),
      });
      const text = await res.text();
      const out = text ? JSON.parse(text) : null;
      if (!res.ok) return { data: null, error: { message: out?.message ?? res.statusText } };
      return { data: out, error: null };
    },
    report: (e) => void reportError(monitor, e, { fn: 'public-forms' }),
  });
});
