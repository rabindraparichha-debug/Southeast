// Parsers for leads from ad forms and directories (lead-intake Edge Function). No external imports.
// - Google Ads lead form extensions: webhook JSON with user_column_data and google_key.
// - Justdial lead API: form/query fields (leadid, name, mobile, area, ...).
// - Generic JSON (website partners, Zapier/Make from Meta or Instagram lead ads).

export type ParsedLead = {
  source: 'google_ads' | 'justdial' | 'instagram' | 'website' | 'referral' | 'other';
  external_id: string;
  name: string | null;
  phone: string | null;
  area: string | null;
  campaign: string | null;
  whatsapp_opt_in: boolean;
  extra: { slots?: string[]; diet?: string; notes?: string };
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
