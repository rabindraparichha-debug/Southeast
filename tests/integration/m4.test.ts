// M4 end-to-end over HTTP: signed WhatsApp webhooks -> bot -> database, the vendor inbox,
// the outbox worker and the customer page. WHATSAPP_MODE=mock (nothing is sent to Meta).
import { beforeAll, describe, expect, it } from 'vitest';
import { hmacSha256Hex } from '../../supabase/functions/_shared/razorpay.ts';
import { KITCHEN_A, anonClient, env, loginAs, type Client } from './helpers';

const APP_SECRET = process.env.WHATSAPP_APP_SECRET ?? 'local-dev-app-secret';
const ANKIT = '919861000002'; // seed customer of kitchen A
let seq = 0;

type Msg = Record<string, unknown>;
async function whatsapp(from: string, message: Msg, signature?: string) {
  const id = `wamid.it_${Date.now()}_${seq++}`;
  const body = JSON.stringify({ entry: [{ changes: [{ value: {
    contacts: [{ wa_id: from, profile: { name: 'IT' } }],
    messages: [{ id, from, ...message }],
  } }] }] });
  const res = await fetch(`${env().url}/functions/v1/whatsapp-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature ?? `sha256=${await hmacSha256Hex(APP_SECRET, body)}` },
    body,
  });
  return { status: res.status, body: (await res.json()) as { processed?: string[]; error?: string } };
}
const text = (body: string) => ({ type: 'text', text: { body } });
const button = (id: string) => ({ type: 'interactive', interactive: { button_reply: { id, title: id } } });

describe('M4: WhatsApp through the webhook', () => {
  let owner: { client: Client; accessToken: string };
  let conversationId: string;

  beforeAll(async () => {
    owner = await loginAs('+919000000001');
  });

  async function lastBotReply(): Promise<string> {
    const { data } = await owner.client.from('messages').select('body').eq('conversation_id', conversationId)
      .eq('direction', 'out').order('created_at', { ascending: false }).limit(1).single();
    return data!.body as string;
  }

  it('M4 test 2: "can I get a discount?" gets no promise and is handed off to the vendor', async () => {
    const res = await whatsapp(ANKIT, text('Hi, can I get a discount?'));
    expect(res.status).toBe(200);
    expect(res.body.processed).toEqual(['guarded']);

    const { data: conv } = await owner.client.from('conversations').select('id, handoff_open, unread_count')
      .eq('kitchen_id', KITCHEN_A).order('last_message_at', { ascending: false }).limit(1).single();
    conversationId = conv!.id;
    expect(conv!.handoff_open).toBe(true);

    const { data: replies } = await owner.client.from('messages').select('body, handled_by').eq('conversation_id', conversationId).eq('direction', 'out');
    const reply = replies!.map((r) => r.body).join('\n');
    expect(reply).toContain('Maa Tarini Tiffin');
    expect(reply).not.toMatch(/\d+\s*%|discount (is|of|for you)|free meal|we will refund/i);

    const { data: alert } = await owner.client.from('notifications_outbox').select('template, payload').eq('template', 'inbox_alert')
      .eq('kitchen_id', KITCHEN_A).order('created_at', { ascending: false }).limit(1).single();
    expect(alert?.payload).toMatchObject({ customer_name: 'Ankit Das' });
  });

  it('M4 test 1 (API form): a WhatsApp pause drops the count for that day and shows in the vendor feed', async () => {
    // The kitchen closes the hand-off so the bot answers again.
    await owner.client.rpc('close_conversation', { p_conversation: conversationId });
    const { data: order } = await owner.client.from('meal_orders').select('service_date, slot, subscription_id')
      .eq('kitchen_id', KITCHEN_A).eq('status', 'scheduled').is('locked_at', null)
      .eq('customer_id', (await owner.client.from('customers_v').select('id').eq('name', 'Ankit Das').single()).data!.id!)
      .gte('service_date', new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10))
      .order('service_date').limit(1).single();
    const date = order!.service_date;
    const before = (await owner.client.rpc('slot_summary', { p_kitchen: KITCHEN_A, p_date: date, p_slot: order!.slot })).data as { live: { total_meals: number } };

    const res = await whatsapp(ANKIT, button(`pause|${date}|3`));
    expect(res.body.processed).toEqual(['pause']);
    expect(await lastBotReply()).toMatch(/paused|updates/i);

    const after = (await owner.client.rpc('slot_summary', { p_kitchen: KITCHEN_A, p_date: date, p_slot: order!.slot })).data as { live: { total_meals: number } };
    expect(after.live.total_meals).toBe(before.live.total_meals - 1);

    const { data: feed } = await owner.client.rpc('change_feed', { p_kitchen: KITCHEN_A, p_since: new Date(Date.now() - 600_000).toISOString() });
    expect(feed!.some((c) => c.channel === 'whatsapp' && c.type === 'pause' && c.customer_name === 'Ankit Das')).toBe(true);
  });

  it('vendor reply is delivered by the outbox worker into the conversation', async () => {
    const sent = await owner.client.rpc('send_vendor_message', { p_conversation: conversationId, p_body: 'Namaskar Ankit, see you tomorrow.' });
    expect(sent.error).toBeNull();
    const res = await fetch(`${env().url}/functions/v1/whatsapp-outbox`, {
      method: 'POST', headers: { apikey: env().anonKey, Authorization: `Bearer ${owner.accessToken}` },
    });
    expect(res.status).toBe(200);
    const { data } = await owner.client.from('messages').select('body, handled_by, status').eq('conversation_id', conversationId)
      .eq('handled_by', 'vendor').order('created_at', { ascending: false }).limit(1).single();
    expect(data).toMatchObject({ body: 'Namaskar Ankit, see you tomorrow.', status: 'sent' });
  });

  it('"my page" sends a magic link that opens the customer page without login', async () => {
    await whatsapp(ANKIT, text('my page'));
    const { data: recent } = await owner.client.from('messages').select('body').eq('conversation_id', conversationId)
      .eq('direction', 'out').order('created_at', { ascending: false }).limit(3);
    const token = recent!.map((m) => /\/c\/([A-Za-z0-9_-]{20,})/.exec(m.body as string)?.[1]).find(Boolean);
    expect(token).toBeTruthy();
    const { data, error } = await anonClient().rpc('portal_get', { p_token: token! });
    expect(error).toBeNull();
    expect((data as { customer: { name: string } }).customer.name).toBe('Ankit Das');
    const bad = await anonClient().rpc('portal_get', { p_token: 'x'.repeat(43) });
    expect(bad.error?.message).toBe('invalid_link');
  });

  it('unknown numbers start the new-customer bot (M7); forged webhooks are rejected', async () => {
    const res = await whatsapp('919999888777', text('hello'));
    expect(res.body.processed).toEqual(['lead_greet']);
    const forged = await whatsapp(ANKIT, text('hi'), 'sha256=deadbeef');
    expect(forged.status).toBe(401);
  });
});
