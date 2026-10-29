// Lead intake from ad forms and directories. Public URL, authenticated by shared keys:
//   POST ?source=google_ads           Google Ads lead form webhook; body.google_key must equal GOOGLE_ADS_LEAD_KEY
//   GET|POST ?source=justdial&key=…   Justdial lead push; key must equal LEAD_INTAKE_KEY
//   POST ?source=instagram|website|referral|other&key=…   generic JSON (Zapier/Make from Meta lead ads, partners)
// Leads are idempotent on (source, external_id), matched to kitchens at once, and welcomed on
// WhatsApp only when the person opted in.
import { corsHeaders, json, rpc } from '../_shared/http.ts';
import { parseGenericLead, parseGoogleAdsLead, parseJustdialLead, safeEqual, type ParsedLead } from '../_shared/leads.ts';
import { loadMonitorConfig, reportError } from '../_shared/monitor.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const LEAD_INTAKE_KEY = Deno.env.get('LEAD_INTAKE_KEY') ?? '';
const GOOGLE_ADS_LEAD_KEY = Deno.env.get('GOOGLE_ADS_LEAD_KEY') ?? '';
const monitor = loadMonitorConfig((k) => Deno.env.get(k));

const GENERIC = new Set(['instagram', 'website', 'referral', 'other']);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const url = new URL(req.url);
  const source = url.searchParams.get('source') ?? '';
  let lead: ParsedLead;
  try {
    if (source === 'google_ads') {
      const body = await req.json();
      if (!safeEqual(String(body.google_key ?? ''), GOOGLE_ADS_LEAD_KEY)) return json({ error: 'forbidden' }, 403);
      lead = parseGoogleAdsLead(body);
    } else {
      const key = url.searchParams.get('key') ?? req.headers.get('x-lead-key') ?? '';
      if (!safeEqual(key, LEAD_INTAKE_KEY)) return json({ error: 'forbidden' }, 403);
      if (source === 'justdial') {
        const fields: Record<string, string> = Object.fromEntries(url.searchParams);
        if (req.method === 'POST') {
          const ct = req.headers.get('content-type') ?? '';
          if (ct.includes('json')) Object.assign(fields, await req.json());
          else Object.assign(fields, Object.fromEntries(new URLSearchParams(await req.text())));
        }
        lead = parseJustdialLead(fields);
      } else if (GENERIC.has(source)) {
        lead = parseGenericLead(await req.json(), source as ParsedLead['source']);
      } else {
        return json({ error: 'unknown_source' }, 400);
      }
    }
  } catch {
    return json({ error: 'invalid_body' }, 400);
  }
  if (!lead.external_id || !lead.phone) return json({ error: 'missing_fields' }, 400);

  const { data, error } = await rpc<{ lead_id: string; duplicate: boolean }>(SUPABASE_URL, SERVICE_ROLE_KEY, `Bearer ${SERVICE_ROLE_KEY}`,
    'lead_ingest', {
      p_source: lead.source, p_external_id: lead.external_id, p_name: lead.name, p_phone: lead.phone, p_area: lead.area,
      p_campaign: lead.campaign, p_whatsapp_opt_in: lead.whatsapp_opt_in,
      p_extra: Object.fromEntries(Object.entries(lead.extra).filter(([, v]) => v !== undefined)),
    });
  if (error && error.message !== 'invalid_phone') await reportError(monitor, new Error(error.message), { fn: 'lead-intake', tags: { source: lead.source } });
  if (error) return json({ error: error.message }, error.message === 'invalid_phone' ? 422 : 500);
  return json(data);
});
