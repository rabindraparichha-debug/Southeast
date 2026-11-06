// Parsers for leads from ad forms and directories (lead-intake Edge Function). No external imports.
// - Google Ads lead form extensions: webhook JSON with user_column_data and google_key.
// - Justdial lead API: form/query fields (leadid, name, mobile, area, ...).
// - Generic JSON (website partners, Zapier/Make from Meta or Instagram lead ads).

export type ParsedLead = {
  source: 'google_ads' | 'justdial' | 'sulekha' | 'instagram' | 'website' | 'referral' | 'other';
  external_id: string;
  name: string | null;
  phone: string | null;
  area: string | null;
  campaign: string | null;
  whatsapp_opt_in: boolean;
  extra: { slots?: string[]; diet?: string; notes?: string };
  gclid?: string | null;
};

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const yes = (v: unknown) => /^(y|yes|true|1|ok|agree|haan|ha)$/i.test(String(v ?? '').trim());

export function parseSlots(v: unknown): string[] | undefined {
  const s = String(v ?? '').toLowerCase();
  if (!s) return undefined;
  const lunch = /lunch|both|day|afternoon/.test(s);
  const dinner = /dinner|both|night|evening/.test(s);
  if (lunch && dinner) return ['lunch', 'dinner'];
  if (lunch) return ['lunch'];
  if (dinner) return ['dinner'];
  return undefined;
}

export function parseDiet(v: unknown): string | undefined {
  const s = String(v ?? '').toLowerCase();
  if (/jain/.test(s)) return 'jain';
  if (/non|chicken|fish|egg|mutton/.test(s)) return 'nonveg';
  if (/veg/.test(s)) return 'veg';
  return undefined;
}

/** Google Ads lead form webhook (https://developers.google.com/google-ads/webhook/docs/overview). */
export function parseGoogleAdsLead(body: Json): ParsedLead {
  const cols: { column_id?: string; column_name?: string; string_value?: string }[] = body.user_column_data ?? [];
  const pick = (re: RegExp) =>
    cols.find((c) => re.test(`${c.column_id ?? ''} ${c.column_name ?? ''}`))?.string_value?.trim() || null;
  const first = pick(/FIRST_NAME/i);
  const last = pick(/LAST_NAME/i);
  return {
    source: 'google_ads',
    external_id: String(body.lead_id ?? ''),
    name: pick(/FULL_NAME/i) ?? ([first, last].filter(Boolean).join(' ') || null),
    phone: pick(/PHONE/i),
    area: pick(/area|locality|location|STREET_ADDRESS/i) ?? pick(/POSTAL_CODE|CITY/i),
    campaign: body.campaign_id ? `gads-${body.campaign_id}` : null,
    whatsapp_opt_in: yes(pick(/whatsapp/i)),
    gclid: body.gcl_id ? String(body.gcl_id) : null,
    extra: {
      slots: parseSlots(pick(/meal|lunch|dinner|time/i)),
      diet: parseDiet(pick(/diet|veg|food/i)),
      ...(body.is_test ? { notes: 'Google Ads test lead' } : {}),
    },
  };
}

/** Justdial lead API push (fields as Justdial sends them; GET query or form POST). */
export function parseJustdialLead(f: Record<string, string>): ParsedLead {
  const name = [f.prefix, f.name].filter(Boolean).join(' ').trim() || null;
  return {
    source: 'justdial',
    external_id: String(f.leadid ?? f.leadId ?? ''),
    name,
    phone: f.mobile || f.phone || null,
    area: f.area || f.brancharea || f.pincode || null,
    campaign: f.category ? `jd-${f.category.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}` : null,
    whatsapp_opt_in: false, // Justdial does not collect WhatsApp consent
    extra: { notes: [f.category, f.city].filter(Boolean).join(', ') || undefined },
  };
}

/** Our own simple format: {external_id, name, phone, area, campaign, slots, diet, whatsapp_opt_in}. */
export function parseGenericLead(body: Json, source: ParsedLead['source']): ParsedLead {
  return {
    source,
    external_id: String(body.external_id ?? body.id ?? ''),
    name: body.name ?? body.full_name ?? null,
    phone: body.phone ?? body.phone_number ?? body.mobile ?? null,
    area: body.area ?? body.locality ?? null,
    campaign: body.campaign ?? null,
    whatsapp_opt_in: body.whatsapp_opt_in === true || yes(body.whatsapp_opt_in),
    extra: { slots: Array.isArray(body.slots) ? body.slots : parseSlots(body.slots ?? body.meal_times), diet: parseDiet(body.diet) },
  };
}

/** Constant-time string comparison for shared keys. */
export function safeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------------------------------------------------------------------------
// Shared intake keys (D-130). Keys travel in a header, never in the URL (URLs end up in access
// logs): X-Lead-Key, or the password of HTTP Basic auth (https://leads:<KEY>@host/... for inbound
// email services that cannot set headers). The only URL key is JUSTDIAL_LEAD_KEY on
// ?source=justdial, because Justdial's push API can only call a URL; it is a separate key, so a
// leaked log line can post Justdial leads and nothing else. Outside a local stack the example
// values from supabase/functions/.env.example (and keys shorter than 24 characters) are refused.
// ---------------------------------------------------------------------------

/** The placeholder values in supabase/functions/.env.example. */
export const EXAMPLE_INTAKE_KEYS = ['local-dev-lead-key', 'local-dev-google-key', 'local-dev-justdial-key'];
export const MIN_INTAKE_KEY_LENGTH = 24;

/** Why a configured key cannot be used ('missing', 'example', 'weak'), or null when it can. */
export function intakeKeyProblem(key: string | null | undefined, local: boolean): 'missing' | 'example' | 'weak' | null {
  const k = (key ?? '').trim();
  if (!k) return 'missing';
  if (local) return null;
  if (EXAMPLE_INTAKE_KEYS.includes(k) || k.startsWith('local-dev-')) return 'example';
  if (k.length < MIN_INTAKE_KEY_LENGTH) return 'weak';
  return null;
}

export type PresentedKey = { header: string | null; basic: string | null; query: string | null };

/** Where the caller put a key: X-Lead-Key, Basic auth password, or ?key= in the URL. */
export function presentedKey(url: URL, headers: { get(name: string): string | null }): PresentedKey {
  let basic: string | null = null;
  const auth = headers.get('authorization') ?? '';
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(auth);
  if (m) {
    try {
      const decoded = atob(m[1]!);
      const i = decoded.indexOf(':');
      basic = i >= 0 ? decoded.slice(i + 1) : null;
    } catch {
      basic = null;
    }
  }
  return {
    header: headers.get('x-lead-key') || null,
    basic: basic || null,
    query: url.searchParams.has('key') ? url.searchParams.get('key') ?? '' : null,
  };
}

export type KeyCheck = { ok: true; via: 'header' | 'basic' | 'url' } | { ok: false; status: 401 | 403 | 503; error: string };

/**
 * Checks the shared key of lead-intake (generic sources, Justdial) and lead-email.
 * keys.intake = LEAD_INTAKE_KEY, keys.justdial = JUSTDIAL_LEAD_KEY.
 */
export function checkLeadKey(source: string, p: PresentedKey, keys: { intake: string; justdial: string }, local: boolean): KeyCheck {
  if (p.query !== null) {
    if (source !== 'justdial') return { ok: false, status: 403, error: 'key_in_url' };
    if (intakeKeyProblem(keys.justdial, local)) return { ok: false, status: 503, error: 'intake_not_configured' };
    return safeEqual(p.query, keys.justdial.trim()) ? { ok: true, via: 'url' } : { ok: false, status: 403, error: 'forbidden' };
  }
  if (intakeKeyProblem(keys.intake, local)) return { ok: false, status: 503, error: 'intake_not_configured' };
  const given = p.header ?? p.basic;
  if (!given) return { ok: false, status: 401, error: 'key_required' };
  return safeEqual(given, keys.intake.trim()) ? { ok: true, via: p.header ? 'header' : 'basic' } : { ok: false, status: 403, error: 'forbidden' };
}

/** Google Ads lead forms send their key in the body (google_key); same configuration rules. */
export function checkGoogleKey(given: unknown, expected: string, local: boolean): KeyCheck {
  if (intakeKeyProblem(expected, local)) return { ok: false, status: 503, error: 'intake_not_configured' };
  return safeEqual(String(given ?? ''), expected.trim()) ? { ok: true, via: 'header' } : { ok: false, status: 403, error: 'forbidden' };
}

// ---------------------------------------------------------------------------
// Lead emails (Sulekha has no public lead API; Justdial and others also email every enquiry).
// The inbound email service (Cloudflare Email Routing worker, Postmark, SendGrid or Mailgun)
// forwards {from, subject, text, messageId}; we read "Label: value" lines.
// ---------------------------------------------------------------------------
export type LeadEmail = { from: string; subject: string; text: string; messageId?: string | null };

const LABELS: Record<'name' | 'phone' | 'area' | 'need', RegExp> = {
  name: /^(customer name|buyer name|contact person|caller name|user name|name)\s*[:\-]/i,
  phone: /^(mobile( no\.?| number)?|phone( no\.?| number)?|contact( no\.?| number)?|caller number|call back number)\s*[:\-]/i,
  area: /^(location|locality|area|address|city area|preferred location|service area)\s*[:\-]/i,
  need: /^(requirement|requirements|category|service|looking for|details|enquiry|enquiry details|message|search(ed)? for)\s*[:\-]/i,
};
const MOBILE = /(?:\+?91[\s-]?)?([6-9]\d{4}[\s-]?\d{5})/;

export function detectEmailSource(from: string): ParsedLead['source'] {
  const f = from.toLowerCase();
  if (f.includes('sulekha')) return 'sulekha';
  if (f.includes('justdial')) return 'justdial';
  return 'other';
}

/** Reads a lead out of a directory's enquiry email; null when no phone number is found. */
export function parseLeadEmail(mail: LeadEmail): ParsedLead | null {
  const fields: Partial<Record<keyof typeof LABELS, string>> = {};
  const lines = mail.text.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const key of Object.keys(LABELS) as (keyof typeof LABELS)[]) {
      if (fields[key] || !LABELS[key].test(line)) continue;
      const value = line.replace(LABELS[key], '').trim() || lines[i + 1] || '';
      if (value) fields[key] = value.slice(0, 200);
    }
  }
  const phoneMatch = MOBILE.exec(fields.phone ?? '') ?? MOBILE.exec(mail.text) ?? MOBILE.exec(mail.subject);
  if (!phoneMatch) return null;
  const phone = phoneMatch[1]!.replace(/[\s-]/g, '');
  const need = [fields.need, mail.subject].filter(Boolean).join(' · ');
  const source = detectEmailSource(mail.from);
  return {
    source,
    external_id: mail.messageId?.trim() || `email:${phone}:${mail.subject.slice(0, 60)}`,
    name: fields.name ?? null,
    phone,
    area: fields.area ?? null,
    campaign: source === 'other' ? 'email' : `${source === 'sulekha' ? 'sk' : 'jd'}-email`,
    whatsapp_opt_in: false,
    extra: { slots: parseSlots(need), diet: parseDiet(need), notes: need ? need.slice(0, 300) : undefined },
  };
}
