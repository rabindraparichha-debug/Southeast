// WhatsApp Cloud API helpers (no external imports: runs in Deno and in the Node tests).
// WHATSAPP_MODE=mock (default without a token) sends nothing; replies are only logged.

import { hmacSha256Hex } from './razorpay.ts';

export type WaMode = 'mock' | 'live';

export type WaConfig = {
  mode: WaMode;
  token?: string;
  phoneNumberId?: string;
  appSecret: string;
  verifyToken: string;
  graphVersion: string;
  /** Public web app URL, for customer page links (https://…/c/<token>). */
  publicWebUrl: string;
};

export function loadWaConfig(env: (name: string) => string | undefined): WaConfig {
  const token = env('WHATSAPP_ACCESS_TOKEN') || undefined;
  const mode = (env('WHATSAPP_MODE') || (token ? 'live' : 'mock')) as WaMode;
  if (mode !== 'mock' && mode !== 'live') throw new Error(`Unknown WHATSAPP_MODE "${mode}"`);
  const appSecret = env('WHATSAPP_APP_SECRET');
  const verifyToken = env('WHATSAPP_VERIFY_TOKEN');
  if (!appSecret || !verifyToken) throw new Error('WHATSAPP_APP_SECRET and WHATSAPP_VERIFY_TOKEN must be set');
  if (mode === 'live' && (!token || !env('WHATSAPP_PHONE_NUMBER_ID'))) {
    throw new Error('Live WhatsApp needs WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID');
  }
  return {
    mode,
    token,
    phoneNumberId: env('WHATSAPP_PHONE_NUMBER_ID') || undefined,
    appSecret,
    verifyToken,
    graphVersion: env('WHATSAPP_GRAPH_VERSION') || 'v21.0',
    publicWebUrl: (env('PUBLIC_WEB_URL') || 'http://localhost:3000').replace(/\/$/, ''),
  };
}

/** Meta signs the raw body with the app secret: X-Hub-Signature-256: sha256=<hex>. */
export async function verifyMetaSignature(body: string, header: string | null, appSecret: string): Promise<boolean> {
  if (!header?.startsWith('sha256=')) return false;
  const expected = await hmacSha256Hex(appSecret, body);
  const got = header.slice(7);
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------
export type Inbound =
  | { kind: 'text'; text: string }
  | { kind: 'reply'; id: string; title?: string }
  | { kind: 'location'; lat: number; lng: number; name?: string }
  | { kind: 'image'; mediaId: string; caption?: string }
  | { kind: 'other' };

export type ParsedMessage = { id: string; from: string; contactName?: string; input: Inbound; body: string };
export type ParsedStatus = { id: string; status: string };

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function parseWebhook(payload: Json): { messages: ParsedMessage[]; statuses: ParsedStatus[] } {
  const messages: ParsedMessage[] = [];
  const statuses: ParsedStatus[] = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value ?? {};
      const names = new Map<string, string>((value.contacts ?? []).map((c: Json) => [c.wa_id, c.profile?.name]));
      for (const m of value.messages ?? []) {
        let input: Inbound = { kind: 'other' };
        if (m.type === 'text') input = { kind: 'text', text: String(m.text?.body ?? '') };
        else if (m.type === 'interactive') {
          const r = m.interactive?.button_reply ?? m.interactive?.list_reply;
          if (r?.id) input = { kind: 'reply', id: String(r.id), title: r.title };
        } else if (m.type === 'button') {
          // Quick-reply buttons on templates.
          input = { kind: 'reply', id: String(m.button?.payload ?? m.button?.text ?? ''), title: m.button?.text };
        } else if (m.type === 'location') {
          input = { kind: 'location', lat: Number(m.location?.latitude), lng: Number(m.location?.longitude), name: m.location?.name };
        } else if (m.type === 'image') {
          input = { kind: 'image', mediaId: String(m.image?.id ?? ''), caption: m.image?.caption };
        }
        const body =
          input.kind === 'text' ? input.text
          : input.kind === 'reply' ? `[${input.title ?? input.id}]`
          : input.kind === 'location' ? `[location ${input.lat.toFixed(5)}, ${input.lng.toFixed(5)}]`
          : input.kind === 'image' ? `[photo]${input.caption ? ' ' + input.caption : ''}`
          : `[${m.type}]`;
        messages.push({ id: String(m.id), from: String(m.from), contactName: names.get(m.from), input, body });
      }
      for (const s of value.statuses ?? []) statuses.push({ id: String(s.id), status: String(s.status) });
    }
  }
  return { messages, statuses };
}

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------
export type Out =
  | { type: 'text'; text: string }
  | { type: 'buttons'; text: string; buttons: { id: string; title: string }[] }
  | { type: 'list'; text: string; button: string; rows: { id: string; title: string; description?: string }[] }
  | { type: 'template'; name: string; language: string; params: string[]; quickReplies?: string[]; preview: string };

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Plain-text rendering used for the message log and the vendor inbox. */
export function previewOf(out: Out): string {
  switch (out.type) {
    case 'text': return out.text;
    case 'buttons': return `${out.text}\n${out.buttons.map((b) => `[${b.title}]`).join(' ')}`;
    case 'list': return `${out.text}\n${out.rows.map((r) => `• ${r.title}`).join('\n')}`;
    case 'template': return out.preview;
  }
}

export function toGraphPayload(to: string, out: Out): Json {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: to.replace(/^\+/, '') };
  switch (out.type) {
    case 'text':
      return { ...base, type: 'text', text: { body: clip(out.text, 4096), preview_url: true } };
    case 'buttons':
      return {
        ...base, type: 'interactive',
        interactive: {
          type: 'button', body: { text: clip(out.text, 1024) },
          action: { buttons: out.buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: clip(b.title, 20) } })) },
        },
      };
    case 'list':
      return {
        ...base, type: 'interactive',
        interactive: {
          type: 'list', body: { text: clip(out.text, 1024) },
          action: {
            button: clip(out.button, 20),
            sections: [{ title: 'Options', rows: out.rows.slice(0, 10).map((r) => ({ id: r.id, title: clip(r.title, 24), description: r.description ? clip(r.description, 72) : undefined })) }],
          },
        },
      };
    case 'template': {
      const components: Json[] = [{ type: 'body', parameters: out.params.map((p) => ({ type: 'text', text: p })) }];
      (out.quickReplies ?? []).forEach((payload, index) =>
        components.push({ type: 'button', sub_type: 'quick_reply', index: String(index), parameters: [{ type: 'payload', payload }] }));
      return { ...base, type: 'template', template: { name: out.name, language: { code: out.language }, components } };
    }
  }
}

export async function sendWhatsApp(cfg: WaConfig, to: string, out: Out): Promise<{ id: string }> {
  if (cfg.mode === 'mock') return { id: `wamid.mock_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}` };
  const res = await fetch(`https://graph.facebook.com/${cfg.graphVersion}/${cfg.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(toGraphPayload(to, out)),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`WhatsApp send failed: ${res.status} ${JSON.stringify(json?.error ?? json)}`);
  return { id: String(json?.messages?.[0]?.id ?? '') };
}
