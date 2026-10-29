// WhatsApp Cloud API webhook: verification handshake (GET) and inbound messages/statuses (POST).
import { chooseKitchenReply, handleMessage, mainMenu, type BotDeps } from '../_shared/bot.ts';
import { handleLeadMessage, handleVendorMessage, parseEntry, type Lead, type VendorState } from '../_shared/lead-bot.ts';
import { t, type Lang } from '../_shared/bot-i18n.ts';
import type { Complete } from '../_shared/ai.ts';
import { parseWebhook, previewOf, verifyMetaSignature, type Out, type ParsedMessage, type WaConfig } from '../_shared/whatsapp.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export type WebhookDeps = {
  cfg: WaConfig;
  /** Calls a Postgres function as the service role; throws Error(code) on failure. */
  rpc: <T = unknown>(fn: string, args: Json) => Promise<T>;
  send: (to: string, out: Out) => Promise<{ id: string }>;
  /** Creates a Razorpay link for a payment row; returns the short URL. */
  createLink: (record: Json) => Promise<string>;
  complete?: Complete;
  /** Error reporting (monitoring); optional. Gets only the error code. */
  report?: (e: unknown, code: string) => void;
};

const ERROR_TEXT: Record<string, string> = {
  payout_account_not_verified: 'Online payment is not set up for this kitchen yet. Please pay them directly (cash or UPI).',
  no_plan: 'You do not have an active plan yet. Tap "Talk to kitchen".',
  kitchen_not_available: 'That kitchen is no longer available. Reply CHANGE to see kitchens again.',
  already_customer: 'You are already a customer of that kitchen. Send "hi" to reach them.',
  date_in_past: 'That date has passed.',
  subscription_cancelled: 'This subscription has ended.',
};

export async function handleWhatsAppWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === 'GET') {
    const ok = url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === deps.cfg.verifyToken;
    return ok ? new Response(url.searchParams.get('hub.challenge') ?? '', { status: 200 }) : new Response('forbidden', { status: 403 });
  }
  if (req.method !== 'POST') return new Response('method_not_allowed', { status: 405 });

  const body = await req.text();
  if (!(await verifyMetaSignature(body, req.headers.get('x-hub-signature-256'), deps.cfg.appSecret))) {
    return new Response(JSON.stringify({ error: 'invalid_signature' }), { status: 401 });
  }
  let payload: Json;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400 });
  }

  const { messages, statuses } = parseWebhook(payload);
  for (const s of statuses) {
    await deps.rpc('wa_message_status', { p_wa_message_id: s.id, p_status: s.status }).catch((e) => console.error('status', e));
  }
  const results: string[] = [];
  for (const m of messages) results.push(await processMessage(m, deps));
  // Always 200 once the signature is valid: messages are deduplicated, so a Meta retry would
  // only be dropped as a duplicate anyway; failures are answered and logged per message instead.
  return new Response(JSON.stringify({ processed: results }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

async function processMessage(m: ParsedMessage, deps: WebhookDeps): Promise<string> {
  const hint = m.input.kind === 'text' ? /\b([a-z0-9]+(?:-[a-z0-9]+)+)\b/.exec(m.input.text.toLowerCase())?.[1] ?? null : null;
  const received = await deps.rpc<Json>('wa_receive', {
    p_message_id: m.id, p_from: m.from, p_body: m.body, p_payload: { input: m.input }, p_contact_name: m.contactName ?? null, p_kitchen_hint: hint,
  });
  if (received.duplicate) return 'duplicate';
  if (received.status === 'ignored') return 'ignored';

  let conversation: string = received.conversation_id;
  const say = async (out: Out, handledBy: string, intent: string | null) => {
    const sent = await deps.send(m.from, out);
    await deps.rpc('wa_log_outbound', {
      p_conversation: conversation, p_body: previewOf(out), p_payload: { type: out.type }, p_wa_message_id: sent.id,
      p_handled_by: handledBy, p_status: deps.cfg.mode === 'mock' ? 'sent' : 'queued', p_intent: intent,
    });
  };

  try {
    if (m.input.kind === 'reply' && m.input.id.startsWith('kitchen|')) {
      conversation = await deps.rpc<string>('wa_select_kitchen', { p_conversation: conversation, p_kitchen: m.input.id.split('|')[1] });
      const ctx = await deps.rpc<Json>('wa_context', { p_conversation: conversation });
      await say(mainMenu(ctx.language as Lang, ctx), 'bot', 'greet');
      return 'kitchen_selected';
    }
    if (received.status === 'choose_kitchen') {
      await say(chooseKitchenReply(received.kitchens), 'bot', 'choose_kitchen');
      return 'choose_kitchen';
    }
    if (received.status === 'unknown') {
      // Not a customer anywhere yet: a new-customer lead, or a kitchen owner signing up.
      const conv = await deps.rpc<Json>('wa_platform_conversation', { p_conversation: conversation });
      const entry = m.input.kind === 'text' ? parseEntry(m.input.text) : { vendor: false, campaign: null, source: 'whatsapp' };
      const vendorState = conv?.state?.flow === 'vendor' ? (conv.state as VendorState) : null;
      if (vendorState || entry.vendor) {
        const r = await handleVendorMessage(m.input, vendorState, (conv?.language ?? 'en') as Lang, {
          setState: (state) => deps.rpc('wa_update_conversation', { p_conversation: conversation, p_state: state }),
          apply: (a) => deps.rpc('wa_vendor_apply', {
            p_phone: m.from, p_name: m.contactName ?? null, p_kitchen_name: a.kitchen_name, p_area: a.area,
            p_subscribers: a.subscribers, p_campaign: a.campaign,
          }),
          signupUrl: `${deps.cfg.publicWebUrl}/login`,
        }, { contactName: m.contactName, campaign: entry.campaign });
        for (const out of r.replies) await say(out, 'bot', r.intent);
        return r.intent;
      }
      const lead = await deps.rpc<Lead>('wa_lead_get', {
        p_phone: m.from, p_campaign: entry.campaign, p_source: entry.source, p_name: m.contactName ?? null,
      });
      const r = await handleLeadMessage(m.input, lead, {
        update: (fields, step) => deps.rpc<Lead>('wa_lead_update', { p_lead: lead.id, p_fields: fields, p_step: step }),
        choose: (kitchenId) => deps.rpc('wa_lead_choose', { p_lead: lead.id, p_kitchen: kitchenId }),
        today: new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10),
      }, { contactName: m.contactName });
      for (const out of r.replies) await say(out, 'bot', r.intent);
      return r.intent;
    }

    const ctx = await deps.rpc<Json>('wa_context', { p_conversation: conversation });
    const result = await handleMessage(m.input, ctx, botDeps(conversation, deps));
    for (const out of result.replies) await say(out, result.handledBy === 'ai' ? 'ai' : 'bot', result.intent);
    return result.intent;
  } catch (e) {
    const code = (e as Error).message;
    console.error('whatsapp message failed', code);
    deps.report?.(e, code);
    await say({ type: 'text', text: ERROR_TEXT[code] ?? 'Sorry, something went wrong. Please try again, or send "talk" to reach the kitchen.' }, 'system', 'error')
      .catch((err) => console.error('error reply failed', err));
    return 'error';
  }
}

function botDeps(conversation: string, deps: WebhookDeps): BotDeps {
  const { rpc } = deps;
  return {
    applyChange: (c, dryRun) => rpc('wa_apply_change', {
      p_conversation: conversation, p_subscription: c.subscription_id, p_type: c.type, p_from: c.from,
      p_to: c.to ?? null, p_slot: c.slot ?? null, p_dry_run: dryRun,
    }),
    handoff: (reason) => rpc('wa_handoff', { p_conversation: conversation, p_reason: reason }),
    complaint: (category, description, photo) => rpc('wa_create_complaint', {
      p_conversation: conversation, p_category: category, p_description: description, p_photo_url: photo,
    }),
    setState: (state) => rpc('wa_update_conversation', { p_conversation: conversation, p_state: state }),
    setLanguage: (language) => rpc('wa_update_conversation', { p_conversation: conversation, p_language: language }),
    setOptIn: (optIn) => rpc('wa_update_conversation', { p_conversation: conversation, p_opt_in: optIn }),
    pageUrl: async () => `${deps.cfg.publicWebUrl}/c/${await rpc<string>('wa_magic_link', { p_conversation: conversation })}`,
    paymentLink: async (meals) => {
      const record = await rpc<Json>('wa_payment_link_record', { p_conversation: conversation, p_meals: meals });
      return { url: await deps.createLink(record), amountPaise: record.amount_paise, meals: record.meals };
    },
    addLocation: (lat, lng, label) => rpc('wa_add_location_address', { p_conversation: conversation, p_lat: lat, p_lng: lng, p_label: label ?? null }),
    complete: deps.complete,
  };
}

export { t };
