// Push notifications through the Expo Push API (no external imports: runs in Deno and in the Node
// tests). The push-outbox function claims channel 'push' rows (push_claim_outbox), turns each into
// one message per device token, sends them in chunks of 100 and records the outcome per row
// (push_complete_outbox). Texts are rendered in the database (private.member_alert_text) so the
// in-app list and the push read the same words.
//
// PUSH_MODE: mock | live. Unset means mock on a local stack and live anywhere else (Expo's API needs
// no key; EXPO_ACCESS_TOKEN is only for "enhanced push security"). Mock is refused outside a local
// stack, so a hosted project never marks a push as sent without sending it. The local check follows
// the PLATFORM_ENV rule of wave 1 (_shared/platform.ts): PLATFORM_ENV=local counts only when
// SUPABASE_URL is local too; switch to platform.ts mockAllowed() once both are merged.

type Env = (name: string) => string | undefined;

export type PushMode = 'mock' | 'live';
export type PushConfig = { mode: PushMode; url: string; accessToken: string | null };

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
export const EXPO_CHUNK = 100; // Expo accepts at most 100 messages per request

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', 'kong', 'host.docker.internal']);

/** True for the URLs a local Supabase stack uses (http://kong:8000 inside the Edge runtime, 127.0.0.1 outside). */
export function isLocalUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return LOCAL_HOSTS.has(host) || host.startsWith('127.') || host.startsWith('supabase_kong_');
}

/** Mock sends are allowed only on a developer's machine. */
export function pushMockAllowed(env: Env): boolean {
  const declared = (env('PLATFORM_ENV') ?? '').trim().toLowerCase();
  const local = isLocalUrl(env('SUPABASE_URL'));
  if (!declared) return local;
  return declared === 'local' && local;
}

export function loadPushConfig(env: Env): PushConfig {
  const raw = (env('PUSH_MODE') ?? '').trim().toLowerCase();
  if (raw && raw !== 'mock' && raw !== 'live') throw new Error(`push_not_configured: PUSH_MODE must be mock or live, got "${raw}"`);
  const mode: PushMode = raw ? (raw as PushMode) : pushMockAllowed(env) ? 'mock' : 'live';
  if (mode === 'mock' && !pushMockAllowed(env)) {
    throw new Error('push_not_configured: mock push runs only on a local stack (PLATFORM_ENV=local); set PUSH_MODE=live');
  }
  const url = (env('EXPO_PUSH_URL') ?? '').trim() || EXPO_PUSH_URL;
  if (!/^https:\/\//.test(url) && !(mode === 'mock' || isLocalUrl(url))) throw new Error('push_not_configured: EXPO_PUSH_URL must be https');
  return { mode, url, accessToken: (env('EXPO_ACCESS_TOKEN') ?? '').trim() || null };
}

/** A claimed outbox row (push_claim_outbox). */
export type PushRow = {
  id: string;
  kitchen_id: string | null;
  recipient_id: string;
  template: string;
  title: string | null;
  body: string | null;
  data: Record<string, unknown> | null;
  tokens: string[] | null;
  attempts: number;
};

export type ExpoMessage = {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  sound: 'default';
  priority: 'high';
  channelId: string;
};

/** Expo push ticket (one per message, in order). */
export type ExpoTicket =
  | { status: 'ok'; id: string }
  | { status: 'error'; message?: string; details?: { error?: string } };

const TOKEN_RE = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$/;

/** Android notification channel used by the app (apps/mobile registers it). */
export const ANDROID_CHANNEL = 'alerts';

/** One message per valid token of each row; rows without a valid token are returned separately. */
export function buildMessages(rows: PushRow[]): { messages: ExpoMessage[]; owners: string[]; noDevice: string[] } {
  const messages: ExpoMessage[] = [];
  const owners: string[] = []; // owners[i] = outbox row id of messages[i]
  const noDevice: string[] = [];
  for (const r of rows) {
    const tokens = [...new Set((r.tokens ?? []).filter((t) => TOKEN_RE.test(t)))];
    if (!tokens.length) {
      noDevice.push(r.id);
      continue;
    }
    for (const to of tokens) {
      messages.push({
        to,
        title: (r.title ?? '').slice(0, 120) || 'Tiffin OS',
        body: (r.body ?? '').slice(0, 400),
        data: { ...(r.data ?? {}), outbox_id: r.id },
        sound: 'default',
        priority: 'high',
        channelId: ANDROID_CHANNEL,
      });
      owners.push(r.id);
    }
  }
  return { messages, owners, noDevice };
}

export function chunk<T>(items: T[], size = EXPO_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export type RowOutcome = { id: string; ok: boolean; error: string | null; deadTokens: string[] };

/**
 * Folds Expo's tickets back onto outbox rows: a row is sent when at least one of its devices took
 * the message; DeviceNotRegistered tokens are reported so they can be switched off. A missing
 * ticket (short response) counts as an error for that message, so the row is retried.
 */
export function interpretTickets(messages: ExpoMessage[], owners: string[], tickets: ExpoTicket[]): RowOutcome[] {
  const byRow = new Map<string, RowOutcome>();
  messages.forEach((m, i) => {
    const id = owners[i]!;
    const o = byRow.get(id) ?? { id, ok: false, error: null, deadTokens: [] };
    const t = tickets[i];
    if (t && t.status === 'ok') {
      o.ok = true;
    } else {
      const code = t && t.status === 'error' ? (t.details?.error ?? t.message ?? 'error') : 'no_ticket';
      if (code === 'DeviceNotRegistered') o.deadTokens.push(m.to);
      o.error ??= String(code).slice(0, 200);
    }
    byRow.set(id, o);
  });
  return [...byRow.values()].map((o) => (o.ok ? { ...o, error: null } : o));
}

/** Request for one chunk (exported for tests). */
export function expoRequest(cfg: PushConfig, messages: ExpoMessage[]): { url: string; init: RequestInit } {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Accept-Encoding': 'gzip, deflate',
    'Content-Type': 'application/json',
  };
  if (cfg.accessToken) headers.Authorization = `Bearer ${cfg.accessToken}`;
  return { url: cfg.url, init: { method: 'POST', headers, body: JSON.stringify(messages) } };
}

/** Sends one chunk; in mock mode every message gets an ok ticket and nothing leaves the machine. */
export async function sendChunk(cfg: PushConfig, messages: ExpoMessage[], fetcher: typeof fetch = fetch): Promise<ExpoTicket[]> {
  if (cfg.mode === 'mock') return messages.map((_, i) => ({ status: 'ok', id: `mock-${i}` }));
  const { url, init } = expoRequest(cfg, messages);
  const res = await fetcher(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`expo_http_${res.status}: ${text.slice(0, 200)}`);
  const body = JSON.parse(text) as { data?: ExpoTicket[]; errors?: { message?: string }[] };
  if (!Array.isArray(body.data)) throw new Error(`expo_bad_response: ${body.errors?.[0]?.message ?? text.slice(0, 200)}`);
  return body.data;
}
