// Supabase Auth "Send SMS" hook: delivers login codes (docs/LOGIN.md, D-126).
// verify_jwt = false (config.toml): Auth calls this before anyone has a session and signs the
// request with the hook secret (Standard Webhooks), which handleSendSmsHook checks first.
// WhatsApp through Twilio (authentication template), SMS through Twilio or Telnyx, in the order of
// AUTH_SMS_ROUTES; AUTH_SMS_MODE=mock sends nothing and runs only on a local stack.
import { handleSendSmsHook } from '../_shared/auth-sms.ts';
import { loadMonitorConfig, reportError } from '../_shared/monitor.ts';

const env = (k: string) => Deno.env.get(k);
const monitor = loadMonitorConfig(env);

Deno.serve(async (req) => {
  const body = await req.text();
  const res = await handleSendSmsHook(
    { method: req.method, headers: (name) => req.headers.get(name), body },
    {
      env,
      fetch,
      now: () => new Date(),
      // Masked phone, channel and error codes only; never the code itself.
      log: (entry) => console.log(JSON.stringify({ fn: 'auth-send-sms', ...entry })),
      report: (error, tags) => void reportError(monitor, error, { fn: 'auth-send-sms', tags }),
    },
  );
  // Auth requires application/json on every answer, errors included.
  return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'Content-Type': 'application/json' } });
});
