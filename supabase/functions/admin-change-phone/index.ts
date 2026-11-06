// Founder support (wave 4): a platform admin changes the login phone of an owner, staff member or
// rider whose SIM was lost or changed. Only the Auth admin API (service role) can change
// auth.users.phone, so this function does it between two database checks made AS THE CALLER:
//   1. admin_phone_change_check (require_admin, a reason, a valid and unused number);
//   2. PUT /auth/v1/admin/users/<id> {phone, phone_confirm: true} with the service role;
//   3. admin_phone_change_done(change) (re-checks auth.users against the pending change, signs the
//      user out everywhere, writes admin_actions with the admin, kitchen, reason and old/new last 4
//      digits from the pending record). A retry after a lost step 3 resumes the same change.
// The caller's JWT is verified by the gateway (verify_jwt) and again by PostgREST; admin rights
// come from platform_admins in the database, never from the request body. No mock mode: it only
// talks to this project's own Auth API.
import { corsHeaders, json, rpc } from '../_shared/http.ts';
import { loadMonitorConfig, reportError } from '../_shared/monitor.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const monitor = loadMonitorConfig((k) => Deno.env.get(k));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function statusFor(code: string | undefined): number {
  if (code === '42501') return 403;
  if (code === '28000') return 401;
  if (code === 'P0002') return 404;
  if (code === '23505') return 409;
  return 400;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const auth = req.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return json({ error: 'not_authenticated' }, 401);

  const body = (await req.json().catch(() => ({}))) as { user_id?: string; new_phone?: string; reason?: string };
  const userId = String(body.user_id ?? '');
  const reason = String(body.reason ?? '').trim();
  if (!UUID.test(userId)) return json({ error: 'not_found' }, 404);
  if (!reason) return json({ error: 'reason_required' }, 400);

  // 1. As the caller: admin, reason, number. Records a pending change (old digits read on the server).
  type Check = { change_id: string; new_phone: string; already_changed: boolean };
  const check = await rpc<Check>(SUPABASE_URL, ANON_KEY, auth,
    'admin_phone_change_check', { p_user: userId, p_new_phone: body.new_phone ?? null, p_reason: reason });
  if (check.error || !check.data) return json({ error: check.error?.message ?? 'forbidden' }, statusFor(check.error?.code));

  // 2. Service role: change the login phone (confirmed, so the next OTP login works at once).
  //    Skipped when an earlier attempt already changed it and only step 3 was lost.
  if (!check.data.already_changed) {
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
        method: 'PUT',
        headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: check.data.new_phone, phone_confirm: true }),
      });
      if (!res.ok) {
        const text = await res.text();
        const taken = res.status === 422 && /already|exists|registered/i.test(text);
        if (!taken) await reportError(monitor, new Error(`auth admin update failed: ${res.status}`), { fn: 'admin-change-phone' });
        return json({ error: taken ? 'phone_in_use' : 'auth_update_failed' }, taken ? 409 : 502);
      }
    } catch (e) {
      await reportError(monitor, e, { fn: 'admin-change-phone' });
      return json({ error: 'auth_update_failed' }, 502);
    }
  }

  // 3. As the caller: finish the pending change (log it, sign the user out everywhere). One retry;
  //    if it still fails, the same request later resumes from here (check returns already_changed).
  type Done = { user_id: string; phone_last4: string; signed_out: boolean };
  const finish = () => rpc<Done>(SUPABASE_URL, ANON_KEY, auth, 'admin_phone_change_done', { p_change: check.data!.change_id });
  let done = await finish();
  if (done.error || !done.data) done = await finish();
  if (done.error || !done.data) {
    await reportError(monitor, new Error(`phone changed but not recorded: ${done.error?.message}`), { fn: 'admin-change-phone' });
    return json({ error: 'not_recorded', changed: true }, 500);
  }
  // Sign-out refused: try once more on its own; the screen warns if it still did not happen.
  if (!done.data.signed_out) {
    const again = await rpc<{ signed_out: boolean }>(SUPABASE_URL, ANON_KEY, auth, 'admin_sign_out_user',
      { p_user: userId, p_reason: reason });
    if (again.data?.signed_out) done.data.signed_out = true;
  }
  return json({ ok: true, ...done.data });
});
