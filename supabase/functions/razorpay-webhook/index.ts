// Razorpay webhook endpoint (verify_jwt = false: Razorpay authenticates with the HMAC signature).
import { handleRazorpayWebhook } from './handler.ts';
import { rpc } from '../_shared/http.ts';
import { loadMonitorConfig, reportError } from '../_shared/monitor.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const monitor = loadMonitorConfig((k) => Deno.env.get(k));

Deno.serve((req) =>
  handleRazorpayWebhook(req, {
    webhookSecret: Deno.env.get('RAZORPAY_WEBHOOK_SECRET') ?? '',
    report: (e) => void reportError(monitor, e, { fn: 'razorpay-webhook' }),
    processEvent: async (eventId, payload) => {
      const { data, error } = await rpc<string>(SUPABASE_URL, SERVICE_ROLE_KEY, `Bearer ${SERVICE_ROLE_KEY}`,
        'razorpay_process_event', { p_event_id: eventId, p_payload: payload });
      if (error) throw new Error(error.message);
      return data ?? 'unknown';
    },
  }),
);
