// M7 end-to-end over HTTP: the website "find a tiffin" flow to a paid trial, a new customer
// qualified by the WhatsApp bot, a kitchen owner signing up on WhatsApp, and Google Ads leads
// through the lead-intake Edge Function. Mock Razorpay and WhatsApp. Needs a fresh `pnpm db:reset`.
import { beforeAll, describe, expect, it } from 'vitest';
import { hmacSha256Hex, mockEvent } from '../../supabase/functions/_shared/razorpay.ts';
import { anonClient, env, loginAs, type Client } from './helpers';

const APP_SECRET = process.env.WHATSAPP_APP_SECRET ?? 'local-dev-app-secret';
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET ?? 'local-dev-webhook-secret';
const GOOGLE_KEY = process.env.GOOGLE_ADS_LEAD_KEY ?? 'local-dev-google-key';
const run = Date.now().toString(36);
let seq = 0;

async function whatsapp(from: string, message: Record<string, unknown>, name = 'IT Lead') {
  const id = `wamid.m7_${run}_${seq++}`;
  const body = JSON.stringify({ entry: [{ changes: [{ value: {
    contacts: [{ wa_id: from, profile: { name } }], messages: [{ id, from, ...message }],
  } }] }] });
  const res = await fetch(`${env().url}/functions/v1/whatsapp-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${await hmacSha256Hex(APP_SECRET, body)}` },
    body,
  });
  return (await res.json()) as { processed?: string[] };
}
const text = (body: string) => ({ type: 'text', text: { body } });
const reply = (id: string) => ({ type: 'interactive', interactive: { button_reply: { id, title: id } } });
const listReply = (id: string) => ({ type: 'interactive', interactive: { list_reply: { id, title: id } } });

async function fn(name: string, body: unknown, init: { query?: string; token?: string } = {}) {
  const { url, anonKey } = env();
  const res = await fetch(`${url}/functions/v1/${name}${init.query ?? ''}`, {
    method: 'POST',
    headers: { apikey: anonKey, Authorization: `Bearer ${init.token ?? anonKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

describe('M7: acquisition over the API', () => {
  let admin: { client: Client; accessToken: string };
  let owner: { client: Client; accessToken: string };
  let kitchenId: string;

  // Its own live kitchen in Patia (test files run in parallel; kitchen A's counts stay untouched).
  beforeAll(async () => {
    [admin, owner] = await Promise.all([loginAs('+919000000099'), loginAs('+919000000103')]);
    const { data: kitchen, error } = await owner.client.rpc('create_kitchen', { p_name: `Lead IT ${run}`, p_area: 'Patia' });
    expect(error).toBeNull();
    kitchenId = (kitchen as { id: string }).id;
    const upd = await owner.client.from('kitchens')
      .update({ lat: 20.358, lng: 85.821, fssai_no: `12026001${String(Date.now()).slice(-6)}` }).eq('id', kitchenId);
    expect(upd.error).toBeNull();
    const plan = await owner.client.from('plans').insert({ kitchen_id: kitchenId, name: 'IT Veg Lunch', slots: ['lunch'], diet: 'veg', price_per_meal_paise: 7000 });
    expect(plan.error).toBeNull();
    const payout = await admin.client.rpc('set_payout_account', { p_kitchen: kitchenId, p_account_id: `acc_TestM7${run}`, p_kyc_status: 'verified' });
    expect(payout.error).toBeNull();
    const live = await admin.client.rpc('set_kitchen_status', { p_kitchen: kitchenId, p_status: 'active' });
    expect(live.error).toBeNull();
  });

  it('website: form → 2–3 kitchens → pick → pay the trial online → trial stage', async () => {
    const anon = anonClient();
    const { data, error } = await anon.rpc('submit_lead', {
      p_name: 'Web Lead', p_phone: '9861000971', p_area: 'Patia', p_slots: ['lunch'], p_diet: 'veg', p_budget_paise: 7000,
      p_consent: true, p_whatsapp_opt_in: true, p_source: 'instagram', p_campaign: `ig-it-${run}`,
    });
    expect(error).toBeNull();
    const res = data as { token: string; status: string; kitchens: { kitchen_id: string; name: string; profile_url: string }[] };
    expect(res.status).toBe('matched');
    expect(res.kitchens.length).toBeGreaterThanOrEqual(1);
    expect(res.kitchens.length).toBeLessThanOrEqual(3);
    expect(res.kitchens.map((k) => k.kitchen_id)).toContain(kitchenId);

    const chose = await anon.rpc('lead_choose', { p_token: res.token, p_kitchen: kitchenId });
    expect(chose.error).toBeNull();
    const c = chose.data as { portal_token: string; trial_meals: number; trial_amount_paise: number; customer_id: string };
    expect(c.trial_meals).toBe(2);

    // The customer pays the trial from their page (no login): Razorpay link, then the webhook.
    const link = await fn('razorpay-payment-link', { token: c.portal_token, meals: c.trial_meals });
    expect(link.status).toBe(200);
    expect(link.body.amount_paise).toBe(c.trial_amount_paise);
    const event = mockEvent('payment_link.paid', {
      payment_link: { id: `plink_m7_${run}`, reference_id: link.body.payment_id },
      payment: { id: `pay_m7_${run}`, amount: c.trial_amount_paise, currency: 'INR', method: 'upi', notes: { payment_id: link.body.payment_id } },
    });
    const hook = await fetch(`${env().url}/functions/v1/razorpay-webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': await hmacSha256Hex(WEBHOOK_SECRET, event), 'X-Razorpay-Event-Id': `evt_m7_${run}` },
      body: event,
    });
    expect(((await hook.json()) as { result: string }).result).toBe('paid');

    // The vendor sees a platform-sourced customer; the platform sees the trial in the funnel.
    const { data: cust } = await owner.client.from('customers_v').select('name, platform_sourced, source').eq('id', c.customer_id).single();
    expect(cust).toMatchObject({ name: 'Web Lead', platform_sourced: true, source: 'platform' });
    const { data: funnel } = await admin.client.rpc('lead_funnel', {});
    const row = (funnel as { source: string; campaign: string; trial: number }[]).find((r) => r.campaign === `ig-it-${run}`);
    expect(row).toMatchObject({ source: 'instagram', trial: 1 });
    // ...and the vendor cannot clear the flag.
    const upd = await owner.client.from('customers').update({ platform_sourced: false } as never).eq('id', c.customer_id);
    expect(upd.error).not.toBeNull();
  });

  it('WhatsApp: an unknown number is qualified by the bot and picks a kitchen', async () => {
    const phone = '919861000972';
    expect((await whatsapp(phone, text('Hi TIFFIN ig-wa-test'), 'Wa Lead')).processed).toEqual(['lead_greet']);
    expect((await whatsapp(phone, { type: 'location', location: { latitude: 20.3549, longitude: 85.8188, name: 'KIIT Square' } })).processed)
      .toEqual(['lead_ask_slots']);
    expect((await whatsapp(phone, reply('l_slots|lunch'))).processed).toEqual(['lead_ask_diet']);
    expect((await whatsapp(phone, reply('l_diet|veg'))).processed).toEqual(['lead_ask_budget']);
    expect((await whatsapp(phone, listReply('l_budget|7000'))).processed).toEqual(['lead_ask_start']);
    expect((await whatsapp(phone, reply('l_start|tomorrow'))).processed).toEqual(['lead_matched']);

    const { data: leads } = await admin.client.rpc('admin_leads', { p_search: 'ig-wa-test' });
    const lead = (leads as { id: string; status: string; source: string; matches: number }[])[0]!;
    expect(lead).toMatchObject({ status: 'matched', source: 'instagram' });
    expect(lead.matches).toBeGreaterThanOrEqual(1);

    expect((await whatsapp(phone, listReply(`l_pick|${kitchenId}`))).processed).toEqual(['lead_chose']);
    const { data: detail } = await admin.client.rpc('admin_lead_detail', { p_lead: lead.id });
    expect((detail as { chosen_kitchen_id: string }).chosen_kitchen_id).toBe(kitchenId);
    // From now on the number is that kitchen's customer: "hi" reaches the kitchen's own bot.
    expect((await whatsapp(phone, text('hi'))).processed).toEqual(['greet']);
  });

  it('WhatsApp: a kitchen owner signs up ("Hi VENDOR")', async () => {
    const phone = '919861000973';
    expect((await whatsapp(phone, text('Hi VENDOR ig-vendors'), 'Gauri Mohanty')).processed).toEqual(['vendor_greet']);
    expect((await whatsapp(phone, text("Gauri's Kitchen"))).processed).toEqual(['vendor_ask_area']);
    expect((await whatsapp(phone, text('Nayapalli'))).processed).toEqual(['vendor_ask_size']);
    expect((await whatsapp(phone, reply('v_size|50'))).processed).toEqual(['vendor_applied']);
    const { data } = await admin.client.rpc('admin_vendor_applications', {});
    const app = (data as { kitchen_name: string; area: string; source: string; campaign: string; subscribers_estimate: number }[])
      .find((a) => a.kitchen_name === "Gauri's Kitchen");
    expect(app).toMatchObject({ area: 'Nayapalli', source: 'whatsapp', campaign: 'ig-vendors', subscribers_estimate: 50 });
  });

  it('Google Ads lead forms come in once, with the key checked', async () => {
    const body = {
      lead_id: `gads-${run}`, campaign_id: 4242, google_key: GOOGLE_KEY,
      user_column_data: [
        { column_id: 'FULL_NAME', string_value: 'Ads Lead' }, { column_id: 'PHONE_NUMBER', string_value: '+919861000974' },
        { column_name: 'Area', string_value: 'Saheed Nagar' }, { column_name: 'Meal times', string_value: 'Dinner' },
      ],
    };
    const first = await fn('lead-intake', body, { query: '?source=google_ads' });
    expect(first.status).toBe(200);
    expect(first.body.duplicate).toBe(false);
    const again = await fn('lead-intake', body, { query: '?source=google_ads' });
    expect(again.body).toMatchObject({ lead_id: first.body.lead_id, duplicate: true });
    const forged = await fn('lead-intake', { ...body, google_key: 'wrong' }, { query: '?source=google_ads' });
    expect(forged.status).toBe(403);
    const { data } = await admin.client.rpc('admin_lead_detail', { p_lead: first.body.lead_id });
    expect(data).toMatchObject({ source: 'google_ads', campaign: 'gads-4242', area: 'Saheed Nagar', slots: ['dinner'] });
    // Saheed Nagar has no active kitchen (B has no FSSAI yet): a demand gap.
    expect((data as { status: string }).status).toBe('waitlist');
  });

  it('keeps leads away from vendors and anon', async () => {
    const asOwner = await owner.client.from('leads').select('id');
    expect(asOwner.data ?? []).toHaveLength(0);
    const anon = await anonClient().from('leads').select('id');
    expect(anon.error).not.toBeNull();
    const notAdmin = await owner.client.rpc('admin_leads', {});
    expect(notAdmin.error?.message).toBe('forbidden');
  });
});
