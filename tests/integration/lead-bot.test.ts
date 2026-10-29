// Unit tests for the WhatsApp lead/vendor bots and the lead-intake parsers (no network, no DB).
import { describe, expect, it } from 'vitest';
import { handleLeadMessage, handleVendorMessage, nextStep, parseEntry, type Lead, type LeadDeps, type VendorState } from '../../supabase/functions/_shared/lead-bot.ts';
import { parseGenericLead, parseGoogleAdsLead, parseJustdialLead, safeEqual } from '../../supabase/functions/_shared/leads.ts';
import type { Out } from '../../supabase/functions/_shared/whatsapp.ts';

const AREAS: Record<string, [number, number]> = { patia: [20.3553, 85.8197], infocity: [20.348, 85.81] };
const KITCHENS = [
  { kitchen_id: 'k1', name: 'Maa Tarini Tiffin', area: 'Patia', distance_km: 0.4, plan_name: 'Veg Lunch', price_per_meal_paise: 7000,
    rating: 4.33, reviews: 6, trial_meals: 2, profile_url: 'http://web/k/maa-tarini-tiffin' },
  { kitchen_id: 'k2', name: 'Infocity Home Kitchen', area: 'Infocity', distance_km: 1.5, plan_name: 'Home Veg Lunch',
    price_per_meal_paise: 6500, rating: null, reviews: 0, trial_meals: 3, profile_url: 'http://web/k/infocity-home-kitchen' },
];

function fakeServer(initial: Partial<Lead> = {}, kitchens = KITCHENS) {
  let lead: Lead = { id: 'L1', status: 'new', bot_step: null, name: null, area: null, lat: null, slots: null, diet: null,
    budget_per_meal_paise: null, start_date: null, language: 'en', kitchens: [], ...initial };
  const calls: { fields: Record<string, unknown>; step: string | null }[] = [];
  const deps: LeadDeps = {
    today: '2026-11-02',
    update: async (fields, step) => {
      calls.push({ fields, step });
      const f = { ...fields };
      if (typeof f.area === 'string') {
        const hit = AREAS[f.area.toLowerCase()];
        if (hit && lead.lat == null) { lead.lat = hit[0]; lead.area = f.area; }
        delete f.area;
      }
      lead = { ...lead, ...(f as Partial<Lead>), bot_step: step };
      if (lead.lat != null && lead.slots?.length && lead.status === 'new') lead.status = 'qualified';
      if (step === 'matched') { lead.kitchens = kitchens; lead.status = kitchens.length ? 'matched' : 'waitlist'; }
      return lead;
    },
    choose: async (id) => ({ kitchen_name: kitchens.find((k) => k.kitchen_id === id)!.name, plan_name: 'Veg Lunch', trial_meals: 2,
      trial_amount_paise: 14000, portal_url: 'http://web/c/tok' }),
  };
  return { deps, get lead() { return lead; }, calls };
}

const text = (o: Out) => (o.type === 'template' ? o.preview : o.text);
const ids = (o: Out) => (o.type === 'buttons' ? o.buttons.map((b) => b.id) : o.type === 'list' ? o.rows.map((r) => r.id) : []);

describe('lead bot: a new customer on WhatsApp', () => {
  it('qualifies step by step, then shows 2–3 kitchens with profile links and prices', async () => {
    const s = fakeServer();
    let r = await handleLeadMessage({ kind: 'text', text: 'Hi TIFFIN ig-oct' }, s.lead, s.deps, { contactName: 'Asha Das' });
    expect(text(r.replies[0]!)).toMatch(/Namaskar Asha/);
    expect(text(r.replies[1]!)).toMatch(/share your location/i);
    r = await handleLeadMessage({ kind: 'location', lat: 20.355, lng: 85.82, name: 'Patia Chhak' }, s.lead, s.deps);
    expect(ids(r.replies[0]!)).toEqual(['l_slots|lunch', 'l_slots|dinner', 'l_slots|both']);
    r = await handleLeadMessage({ kind: 'reply', id: 'l_slots|lunch' }, s.lead, s.deps);
    expect(ids(r.replies[0]!)).toEqual(['l_diet|veg', 'l_diet|nonveg', 'l_diet|jain']);
    r = await handleLeadMessage({ kind: 'reply', id: 'l_diet|veg' }, s.lead, s.deps);
    expect(r.replies[0]!.type).toBe('list');
    r = await handleLeadMessage({ kind: 'reply', id: 'l_budget|7000' }, s.lead, s.deps);
    expect(ids(r.replies[0]!)).toContain('l_start|tomorrow');
    r = await handleLeadMessage({ kind: 'reply', id: 'l_start|tomorrow' }, s.lead, s.deps);
    expect(r.intent).toBe('lead_matched');
    expect(s.lead).toMatchObject({ lat: 20.355, slots: ['lunch'], diet: 'veg', budget_per_meal_paise: 7000, start_date: '2026-11-03' });
    expect(text(r.replies[0]!)).toContain('Maa Tarini Tiffin');
    expect(text(r.replies[0]!)).toContain('₹70/meal');
    expect(text(r.replies[0]!)).toContain('http://web/k/maa-tarini-tiffin');
    expect(text(r.replies[0]!)).toContain('New'); // no ratings yet
    expect(ids(r.replies[1]!)).toEqual(['l_pick|k1', 'l_pick|k2']);
  });

  it('accepts a typed area and free-text answers', async () => {
    const s = fakeServer();
    await handleLeadMessage({ kind: 'text', text: 'hello' }, s.lead, s.deps);
    let r = await handleLeadMessage({ kind: 'text', text: 'Infocity' }, s.lead, s.deps);
    expect(s.lead.lat).toBe(20.348);
    r = await handleLeadMessage({ kind: 'text', text: 'both please' }, s.lead, s.deps);
    expect(s.lead.slots).toEqual(['lunch', 'dinner']);
    r = await handleLeadMessage({ kind: 'text', text: 'non veg, fish' }, s.lead, s.deps);
    expect(s.lead.diet).toBe('nonveg');
    r = await handleLeadMessage({ kind: 'text', text: '80' }, s.lead, s.deps);
    expect(s.lead.budget_per_meal_paise).toBe(8000);
    expect(r.intent).toBe('lead_ask_start');
  });

  it('asks again for an unknown area', async () => {
    const s = fakeServer();
    await handleLeadMessage({ kind: 'text', text: 'hi' }, s.lead, s.deps);
    const r = await handleLeadMessage({ kind: 'text', text: 'Atlantis' }, s.lead, s.deps);
    expect(r.intent).toBe('lead_area_unknown');
    expect(s.lead.bot_step).toBe('location');
  });

  it('skips questions a web or ads form already answered', async () => {
    const s = fakeServer({ lat: 20.35, area: 'Patia', slots: ['lunch'], diet: 'veg', budget_per_meal_paise: 7000, start_date: '2026-11-04' });
    const r = await handleLeadMessage({ kind: 'reply', id: 'lead_start' }, s.lead, s.deps);
    expect(r.intent).toBe('lead_matched');
    expect(nextStep({ ...s.lead, bot_step: null })).toBe('matched');
  });

  it('budget "Any" is accepted and not asked again', async () => {
    const s = fakeServer({ lat: 20.35, slots: ['lunch'], diet: 'veg', bot_step: 'budget' });
    const r = await handleLeadMessage({ kind: 'reply', id: 'l_budget|any' }, s.lead, s.deps);
    expect(r.intent).toBe('lead_ask_start');
    expect(s.lead.budget_per_meal_paise).toBeNull();
  });

  it('picking a kitchen gives the paid-trial link and the refund terms', async () => {
    const s = fakeServer({ lat: 20.35, slots: ['lunch'], diet: 'veg', bot_step: 'matched', kitchens: KITCHENS });
    const r = await handleLeadMessage({ kind: 'reply', id: 'l_pick|k1' }, s.lead, s.deps);
    expect(r.intent).toBe('lead_chose');
    expect(text(r.replies[0]!)).toMatch(/2 meals for ₹140/);
    expect(text(r.replies[0]!)).toContain('http://web/c/tok');
    expect(text(r.replies[0]!)).toMatch(/refunded/);
  });

  it('no kitchen nearby: waitlist message, CHANGE restarts', async () => {
    const s = fakeServer({ lat: 20.25, area: 'Khandagiri', slots: ['lunch'], diet: 'veg', budget_per_meal_paise: 6000, bot_step: 'start' }, []);
    let r = await handleLeadMessage({ kind: 'reply', id: 'l_start|week' }, s.lead, s.deps);
    expect(r.intent).toBe('lead_waitlist');
    expect(text(r.replies[0]!)).toMatch(/no kitchen near Khandagiri/);
    r = await handleLeadMessage({ kind: 'text', text: 'CHANGE' }, s.lead, s.deps);
    expect(r.intent).toBe('lead_restart');
    expect(s.lead.bot_step).toBe('location');
  });

  it('answers in Odia when the customer writes in Odia', async () => {
    const s = fakeServer();
    const r = await handleLeadMessage({ kind: 'text', text: 'ନମସ୍କାର' }, s.lead, s.deps);
    expect(s.lead.language).toBe('or');
    expect(text(r.replies[0]!)).toMatch(/ନମସ୍କାର/);
  });

  it('reads campaign codes from click-to-chat links', () => {
    expect(parseEntry('Hi TIFFIN ig-oct-reel')).toEqual({ vendor: false, campaign: 'ig-oct-reel', source: 'instagram' });
    expect(parseEntry('Hi TIFFIN gads-bbsr')).toMatchObject({ source: 'google_ads' });
    expect(parseEntry('I need tiffin near KIIT')).toEqual({ vendor: false, campaign: null, source: 'whatsapp' });
    expect(parseEntry('Hi VENDOR ig-vendors')).toEqual({ vendor: true, campaign: 'ig-vendors', source: 'instagram' });
    expect(parseEntry('I am a mess owner')).toMatchObject({ vendor: true });
  });
});

describe('vendor bot: a kitchen owner signs up on WhatsApp', () => {
  it('asks kitchen name, area and size, then records the application', async () => {
    let state: VendorState | null = null;
    let applied: unknown;
    const deps = {
      setState: async (s: VendorState | Record<string, never>) => { state = 'flow' in s ? (s as VendorState) : null; },
      apply: async (a: unknown) => { applied = a; },
      signupUrl: 'http://web/login',
    };
    let r = await handleVendorMessage({ kind: 'text', text: 'Hi VENDOR jd-x' }, state, 'en', deps, { contactName: 'Kabita Nayak', campaign: 'jd-x' });
    expect(text(r.replies[0]!)).toMatch(/free software/);
    r = await handleVendorMessage({ kind: 'text', text: "Kabita's Rasoi" }, state, 'en', deps);
    expect(r.intent).toBe('vendor_ask_area');
    r = await handleVendorMessage({ kind: 'text', text: 'Khandagiri' }, state, 'en', deps);
    expect(ids(r.replies[0]!)).toEqual(['v_size|10', 'v_size|50', 'v_size|150']);
    r = await handleVendorMessage({ kind: 'reply', id: 'v_size|50' }, state, 'en', deps);
    expect(r.intent).toBe('vendor_applied');
    expect(applied).toEqual({ kitchen_name: "Kabita's Rasoi", area: 'Khandagiri', subscribers: 50, campaign: 'jd-x' });
    expect(text(r.replies[0]!)).toContain('http://web/login');
    expect(state).toBeNull();
  });
});

describe('lead-intake parsers', () => {
  it('reads a Google Ads lead form webhook', () => {
    const l = parseGoogleAdsLead({
      lead_id: 'TeSter-123', campaign_id: 987, google_key: 'k', is_test: true,
      user_column_data: [
        { column_id: 'FULL_NAME', string_value: 'Sneha Mallick' },
        { column_id: 'PHONE_NUMBER', string_value: '+919861000903' },
        { column_name: 'Your area', string_value: 'Khandagiri' },
        { column_name: 'Meal times', string_value: 'Lunch and dinner' },
        { column_name: 'Veg or non-veg?', string_value: 'Non-veg' },
        { column_name: 'OK to WhatsApp you?', string_value: 'Yes' },
      ],
    });
    expect(l).toMatchObject({ source: 'google_ads', external_id: 'TeSter-123', name: 'Sneha Mallick', phone: '+919861000903',
      area: 'Khandagiri', campaign: 'gads-987', whatsapp_opt_in: true });
    expect(l.extra).toMatchObject({ slots: ['lunch', 'dinner'], diet: 'nonveg' });
  });

  it('reads a Justdial lead push', () => {
    const l = parseJustdialLead({ leadid: 'JD77', prefix: 'Mr', name: 'Rajesh Sahoo', mobile: '9861000904', area: 'Old Town', category: 'Tiffin Services', city: 'Bhubaneswar' });
    expect(l).toMatchObject({ source: 'justdial', external_id: 'JD77', name: 'Mr Rajesh Sahoo', phone: '9861000904', area: 'Old Town',
      campaign: 'jd-tiffin-services', whatsapp_opt_in: false });
  });

  it('reads the generic format and compares keys safely', () => {
    expect(parseGenericLead({ id: 'z1', name: 'A', phone: '9861000999', area: 'Patia', meal_times: 'dinner', whatsapp_opt_in: 'yes' }, 'instagram'))
      .toMatchObject({ external_id: 'z1', whatsapp_opt_in: true, extra: { slots: ['dinner'] } });
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('', '')).toBe(false);
  });
});
