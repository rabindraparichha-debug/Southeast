// Inbound lead emails → leads. For directories without a lead API (Sulekha) and as a fallback for
// Justdial: forward their enquiry emails to an address handled by an inbound-email service, which
// posts here with ?key=LEAD_INTAKE_KEY. Accepts:
//   - JSON {from, subject, text, message_id}   (our Cloudflare Email Routing worker, see docs/LEAD_SOURCES.md)
//   - Postmark inbound JSON {From, Subject, TextBody, MessageID}
//   - SendGrid Inbound Parse / Mailgun routes (multipart or urlencoded form: from|sender, subject, text|body-plain)
import { corsHeaders, json, rpc } from '../_shared/http.ts';
import { parseLeadEmail, safeEqual, type LeadEmail } from '../_shared/leads.ts';
import { loadMonitorConfig, reportError } from '../_shared/monitor.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const LEAD_INTAKE_KEY = Deno.env.get('LEAD_INTAKE_KEY') ?? '';
const monitor = loadMonitorConfig((k) => Deno.env.get(k));

async function readMail(req: Request): Promise<LeadEmail> {
  const ct = req.headers.get('content-type') ?? '';
  if (ct.includes('json')) {
    const b = await req.json();
    return {
      from: String(b.from ?? b.From ?? b.FromFull?.Email ?? ''),
      subject: String(b.subject ?? b.Subject ?? ''),
      text: String(b.text ?? b.TextBody ?? b['body-plain'] ?? ''),
      messageId: b.message_id ?? b.MessageID ?? null,
    };
  }
  const f = await req.formData();
  const g = (k: string) => (typeof f.get(k) === 'string' ? (f.get(k) as string) : '');
  const headers = g('headers');
  return {
    from: g('from') || g('sender'),
    subject: g('subject'),
    text: g('text') || g('body-plain') || g('stripped-text'),
    messageId: g('Message-Id') || /^message-id:\s*(.+)$/im.exec(headers)?.[1] || null,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const key = new URL(req.url).searchParams.get('key') ?? req.headers.get('x-lead-key') ?? '';
  if (!safeEqual(key, LEAD_INTAKE_KEY)) return json({ error: 'forbidden' }, 403);
  let mail: LeadEmail;
  try {
    mail = await readMail(req);
  } catch {
    return json({ error: 'invalid_body' }, 400);
  }
  const lead = parseLeadEmail(mail);
  // 200 even when nothing was found, so the email service doesn't retry a newsletter forever.
  if (!lead) return json({ result: 'no_lead' });
  const { data, error } = await rpc<{ lead_id: string; duplicate: boolean }>(SUPABASE_URL, SERVICE_ROLE_KEY, `Bearer ${SERVICE_ROLE_KEY}`,
    'lead_ingest', {
      p_source: lead.source, p_external_id: lead.external_id, p_name: lead.name, p_phone: lead.phone, p_area: lead.area,
      p_campaign: lead.campaign, p_whatsapp_opt_in: false,
      p_extra: Object.fromEntries(Object.entries(lead.extra).filter(([, v]) => v !== undefined)),
    });
  if (error) {
    if (error.message !== 'invalid_phone') await reportError(monitor, new Error(error.message), { fn: 'lead-email', tags: { source: lead.source } });
    return json({ error: error.message }, error.message === 'invalid_phone' ? 200 : 500);
  }
  return json({ result: 'ok', source: lead.source, ...data });
});
