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
