// Unit tests for the WhatsApp bot, AI guardrails, templates and Cloud API parsing (no network/DB).
import { describe, expect, it } from 'vitest';
import { handleMessage, detectIntent, type BotDeps, type Change } from '../../supabase/functions/_shared/bot.ts';
import { guardReply, needsHuman } from '../../supabase/functions/_shared/ai.ts';
import { renderOutbox } from '../../supabase/functions/_shared/templates.ts';
import { parseWebhook, previewOf, toGraphPayload, verifyMetaSignature } from '../../supabase/functions/_shared/whatsapp.ts';
import { hmacSha256Hex } from '../../supabase/functions/_shared/razorpay.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function ctx(over: Json = {}): Json {
  return {
    matched: true, language: 'en', state: {}, handoff_open: false, opted_in: true, today: '2026-11-02',
    customer: { id: 'c1', name: 'Asha Das' },
    kitchen: { id: 'k1', name: 'Maa Tarini Tiffin', online_payments: true, cutoff_lunch: '21:00:00', cutoff_lunch_prev_day: true, cutoff_dinner: '12:00:00', cutoff_dinner_prev_day: false },
    balance: { meals: 12, value_paise: 84000, low_threshold: 3 },
    subscriptions: [{ id: 's1', status: 'active', plan: 'Veg Lunch', price_paise: 7000 }],
    meals: [
      { subscription_id: 's1', date: '2026-11-03', slot: 'lunch', status: 'scheduled', locked: false, open: true },
      { subscription_id: 's1', date: '2026-11-04', slot: 'lunch', status: 'scheduled', locked: false, open: true },
    ],
    menus: [{ date: '2026-11-02', slot: 'lunch', dishes: ['Rice', 'Dalma'] }],
    ...over,
  };
}

function fakeDeps(opts: { charged?: boolean; ai?: Json | null } = {}) {
  const calls: { applied: [Change, boolean][]; handoffs: string[]; states: Json[]; complaints: string[] } = { applied: [], handoffs: [], states: [], complaints: [] };
  const deps: BotDeps = {
    applyChange: async (c, dry) => {
      calls.applied.push([c, dry]);
      return { after_cutoff: Boolean(opts.charged), affected: [{ date: c.from, slot: c.slot ?? 'lunch', late: Boolean(opts.charged), charged: Boolean(opts.charged) }] };
    },
    handoff: async (r) => { calls.handoffs.push(r); },
    complaint: async (cat) => { calls.complaints.push(cat); return 'abcdef123'; },
    setState: async (s) => { calls.states.push(s); },
    setLanguage: async () => {},
    setOptIn: async () => {},
    pageUrl: async () => 'http://localhost:3000/c/token',
    paymentLink: async (meals) => ({ url: 'https://rzp.io/x', amountPaise: meals * 7000, meals }),
    addLocation: async () => {},
    complete: opts.ai === undefined ? undefined : async () => opts.ai as never,
  };
  return { deps, calls };
}

const text = (s: string) => ({ kind: 'text' as const, text: s });
const reply = (id: string) => ({ kind: 'reply' as const, id });

describe('bot flows', () => {
  it('greets with the 10-option menu and asks for opt-in once', async () => {
    const { deps, calls } = fakeDeps();
    const res = await handleMessage(text('Hi'), ctx({ opted_in: false }), deps);
    expect(res.replies[0]).toMatchObject({ type: 'list' });
    expect((res.replies[0] as Json).rows).toHaveLength(10);
    expect(previewOf(res.replies[1]!)).toContain('updates');
    expect(calls.states.at(-1)).toEqual({ optin_asked: true });
  });

  it('M4 test 2: "can I get a discount?" gets no promise and is handed off to the kitchen', async () => {
    const { deps, calls } = fakeDeps({ ai: { reply: 'Sure, 20% discount for you!', intent: 'answer', handoff: false } });
    const res = await handleMessage(text('can I get a discount?'), ctx(), deps);
    expect(calls.handoffs).toHaveLength(1);
    const out = previewOf(res.replies[0]!);
    expect(out).toContain('Maa Tarini Tiffin');
    expect(out).not.toMatch(/discount|free|refund|%/i);
    expect(res.intent).toBe('guarded');
  });

  it('on-time skip applies right away after a dry run', async () => {
    const { deps, calls } = fakeDeps();
    const list = await handleMessage(reply('m:skip'), ctx(), deps);
    expect((list.replies[0] as Json).rows[0].id).toBe('skip|s1|2026-11-03|lunch');
    const res = await handleMessage(reply('skip|s1|2026-11-03|lunch'), ctx(), deps);
    expect(calls.applied.map(([, dry]) => dry)).toEqual([true, false]);
    expect(previewOf(res.replies[0]!)).toBe('Done. Skipped: Tue, 3 Nov Lunch.');
  });

  it('late skip warns first and only applies after the customer confirms', async () => {
    const { deps, calls } = fakeDeps({ charged: true });
    const res = await handleMessage(reply('skip|s1|2026-11-03|lunch'), ctx(), deps);
    expect(previewOf(res.replies[0]!)).toMatch(/past the cutoff.*still be charged/);
    expect(calls.applied.map(([, dry]) => dry)).toEqual([true]);
    const pending = calls.states.at(-1)!;
    expect(pending.step).toBe('confirm');

    const confirmed = await handleMessage(reply('c:yes'), ctx({ state: pending }), deps);
    expect(calls.applied.map(([, dry]) => dry)).toEqual([true, false]);
    expect(previewOf(confirmed.replies[0]!)).toContain('still charged');

    const declined = await handleMessage(reply('c:no'), ctx({ state: pending }), deps);
    expect(previewOf(declined.replies[0]!)).toBe('OK, nothing changed.');
  });

  it('asking for opt-in does not wipe a pending confirmation', async () => {
    const { deps, calls } = fakeDeps({ charged: true });
    await handleMessage(reply('skip|s1|2026-11-03|lunch'), ctx({ opted_in: false }), deps);
    expect(calls.states.at(-1)).toMatchObject({ step: 'confirm', optin_asked: true });
  });

  it('pause for 3 days covers the start day + 2', async () => {
    const { deps, calls } = fakeDeps();
    await handleMessage(reply('pause|2026-11-03|3'), ctx(), deps);
    expect(calls.applied.at(-1)![0]).toMatchObject({ type: 'pause', from: '2026-11-03', to: '2026-11-05' });
  });

  it('pay shows terms before payment', async () => {
    const { deps } = fakeDeps();
    const res = await handleMessage(reply('pay|26'), ctx(), deps);
    const out = previewOf(res.replies[0]!);
    expect(out).toContain('₹1,820');
    expect(out).toContain('unused meals are refunded at the price you paid');
  });

  it('stays silent while the kitchen is handling the conversation', async () => {
    const { deps } = fakeDeps();
    const res = await handleMessage(text('ok thanks, see you'), ctx({ handoff_open: true }), deps);
    expect(res.replies).toEqual([]);
  });

  it('speaks Hindi and Odia when the customer chose it', async () => {
    const { deps } = fakeDeps();
    expect(previewOf((await handleMessage(text('hi'), ctx({ language: 'hi' }), deps)).replies[0]!)).toContain('नमस्ते');
    expect(previewOf((await handleMessage(text('hi'), ctx({ language: 'or' }), deps)).replies[0]!)).toContain('ନମସ୍କାର');
  });

  it('complaint flow: category, then description, then acknowledgement with a reference', async () => {
    const { deps, calls } = fakeDeps();
    await handleMessage(reply('cmp|late'), ctx(), deps);
    const res = await handleMessage(text('came at 2pm'), ctx({ state: calls.states.at(-1) }), deps);
    expect(calls.complaints).toEqual(['late']);
    expect(previewOf(res.replies[0]!)).toContain('#ABCDEF');
  });
});

describe('AI fallback guardrails', () => {
  it('keyword intents work in English, Hindi and Odia', () => {
    expect(detectIntent('please skip tomorrow')).toBe('skip');
    expect(detectIntent('मेनू क्या है')).toBe('menu');
    expect(detectIntent('ଅଭିଯୋଗ')).toBe('complaint');
    expect(needsHuman('kuch chhoot milega?')).toBe(true);
    expect(needsHuman('can I get my money back')).toBe(true);
  });

  it('a reply with a price not in the facts is replaced by a hand-off', () => {
    const c = ctx();
    expect(guardReply({ reply: 'It costs ₹999 a month.', intent: 'answer', handoff: false }, c).handoff).toBe(true);
    expect(guardReply({ reply: 'Your plan is ₹70 per meal.', intent: 'answer', handoff: false }, c).handoff).toBe(false);
    expect(guardReply({ reply: 'We will give you a free meal.', intent: 'answer', handoff: false }, c).handoff).toBe(true);
  });

  it('unknown questions go to the kitchen; supported actions run the menu flow', async () => {
    const { deps, calls } = fakeDeps({ ai: { reply: '', intent: 'other', handoff: true } });
    await handleMessage(text('do you cater weddings?'), ctx(), deps);
    expect(calls.handoffs).toHaveLength(1);

    const { deps: d2 } = fakeDeps({ ai: { reply: 'Sure.', intent: 'skip', handoff: false } });
    const res = await handleMessage(text('wont be around on tuesday'), ctx(), d2);
    expect(res.replies[0]).toMatchObject({ type: 'list' });
    expect(res.handledBy).toBe('ai');
  });

  it('a model refusal (null) hands off', async () => {
    const { deps, calls } = fakeDeps({ ai: null });
    await handleMessage(text('tell me something'), ctx(), deps);
    expect(calls.handoffs).toHaveLength(1);
  });
});

describe('templates and Cloud API payloads', () => {
  it('uses a template outside the 24h window and a normal message inside it', () => {
    const p = { date: '2026-11-03', dishes: ['Rice', 'Dalma'] };
    const outside = renderOutbox('tomorrow_menu', p, 'hi', 'Maa Tarini Tiffin', false)!;
    expect(outside).toMatchObject({ type: 'template', name: 'tomorrow_menu_v1', language: 'hi', quickReplies: ['nudge_skip|2026-11-03', 'nudge_keep'] });
    const inside = renderOutbox('tomorrow_menu', p, 'en', 'Maa Tarini Tiffin', true)!;
    expect(inside.type).toBe('buttons');
    expect(previewOf(inside)).toContain('Rice, Dalma');
    expect(renderOutbox('unknown_template', {}, 'en', 'K', true)).toBeNull();
  });

  it('parses text, button, list, location and status webhooks', () => {
    const payload = { entry: [{ changes: [{ value: {
      contacts: [{ wa_id: '919861000001', profile: { name: 'Asha' } }],
      messages: [
        { id: 'w1', from: '919861000001', type: 'text', text: { body: 'hi' } },
        { id: 'w2', from: '919861000001', type: 'interactive', interactive: { list_reply: { id: 'm:skip', title: 'Skip a meal' } } },
        { id: 'w3', from: '919861000001', type: 'button', button: { payload: 'nudge_keep', text: 'Keep' } },
        { id: 'w4', from: '919861000001', type: 'location', location: { latitude: 20.35, longitude: 85.82 } },
      ],
      statuses: [{ id: 'wamid.x', status: 'delivered' }],
    } }] }] };
    const { messages, statuses } = parseWebhook(payload);
    expect(messages.map((m) => m.input.kind)).toEqual(['text', 'reply', 'reply', 'location']);
    expect(messages[0]!.contactName).toBe('Asha');
    expect(statuses).toEqual([{ id: 'wamid.x', status: 'delivered' }]);
  });

  it('clips button titles to WhatsApp limits and verifies Meta signatures', async () => {
    const g = toGraphPayload('+919861000001', { type: 'buttons', text: 'x', buttons: [{ id: 'a', title: 'A very long button title indeed' }] });
    expect(g.to).toBe('919861000001');
    expect(g.interactive.action.buttons[0].reply.title.length).toBeLessThanOrEqual(20);
    const body = '{"x":1}';
    expect(await verifyMetaSignature(body, `sha256=${await hmacSha256Hex('app', body)}`, 'app')).toBe(true);
    expect(await verifyMetaSignature(body, 'sha256=00', 'app')).toBe(false);
  });
});
