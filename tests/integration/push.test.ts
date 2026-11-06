// Unit tests for the push sender's pure logic (no network): mode resolution with the local-only mock
// rule, message building, chunking, folding Expo tickets back onto outbox rows, and the request.
import { describe, expect, it } from 'vitest';
import {
  buildMessages, chunk, EXPO_PUSH_URL, expoRequest, interpretTickets, isLocalUrl, loadPushConfig, pushMockAllowed, sendChunk,
  type ExpoTicket, type PushRow,
} from '../../supabase/functions/_shared/push.ts';

const env = (vars: Record<string, string | undefined>) => (k: string) => vars[k];
const LOCAL = 'http://kong:8000';
const HOSTED = 'https://abcd.supabase.co';

const row = (id: string, tokens: string[], extra: Partial<PushRow> = {}): PushRow => ({
  id, kitchen_id: 'k1', recipient_id: 'u1', template: 'production_sheet', title: 'Final count: Lunch Tue 10 Nov',
  body: '42 meals', data: { path: '/' }, tokens, attempts: 1, ...extra,
});
const T1 = 'ExponentPushToken[aaaaaaaaaaaa]';
const T2 = 'ExponentPushToken[bbbbbbbbbbbb]';
const T3 = 'ExpoPushToken[cccccccccccc]';

describe('push mode', () => {
  it('recognises local stack URLs', () => {
    expect(isLocalUrl(LOCAL)).toBe(true);
    expect(isLocalUrl('http://127.0.0.1:54321')).toBe(true);
    expect(isLocalUrl('http://supabase_kong_tiffin:8000')).toBe(true);
    expect(isLocalUrl(HOSTED)).toBe(false);
    expect(isLocalUrl('not a url')).toBe(false);
    expect(isLocalUrl(undefined)).toBe(false);
  });

  it('allows mock only on a local stack', () => {
    expect(pushMockAllowed(env({ SUPABASE_URL: LOCAL }))).toBe(true);
    expect(pushMockAllowed(env({ SUPABASE_URL: LOCAL, PLATFORM_ENV: 'local' }))).toBe(true);
    expect(pushMockAllowed(env({ SUPABASE_URL: HOSTED }))).toBe(false);
    // Declaring "local" on a hosted project does not unlock mock mode.
    expect(pushMockAllowed(env({ SUPABASE_URL: HOSTED, PLATFORM_ENV: 'local' }))).toBe(false);
    expect(pushMockAllowed(env({ SUPABASE_URL: LOCAL, PLATFORM_ENV: 'staging' }))).toBe(false);
  });

  it('defaults to mock locally and live on a hosted project', () => {
    expect(loadPushConfig(env({ SUPABASE_URL: LOCAL })).mode).toBe('mock');
    const hosted = loadPushConfig(env({ SUPABASE_URL: HOSTED }));
    expect(hosted).toEqual({ mode: 'live', url: EXPO_PUSH_URL, accessToken: null });
    expect(loadPushConfig(env({ SUPABASE_URL: LOCAL, PUSH_MODE: 'live', EXPO_ACCESS_TOKEN: 'tok' })))
      .toEqual({ mode: 'live', url: EXPO_PUSH_URL, accessToken: 'tok' });
  });

  it('refuses mock on a hosted project (fails closed) and unknown modes', () => {
    expect(() => loadPushConfig(env({ SUPABASE_URL: HOSTED, PUSH_MODE: 'mock' }))).toThrow(/^push_not_configured/);
    expect(() => loadPushConfig(env({ SUPABASE_URL: LOCAL, PUSH_MODE: 'carrier-pigeon' }))).toThrow(/^push_not_configured/);
    expect(() => loadPushConfig(env({ SUPABASE_URL: HOSTED, EXPO_PUSH_URL: 'http://evil.example/push' }))).toThrow(/https/);
  });
});

describe('messages', () => {
  it('builds one message per valid, distinct token and reports rows without a device', () => {
    const { messages, owners, noDevice } = buildMessages([
      row('r1', [T1, T2, T1]),
      row('r2', []),
      row('r3', ['garbage']),
      row('r4', [T3], { title: null, body: null, data: null }),
    ]);
    expect(messages.map((m) => m.to)).toEqual([T1, T2, T3]);
    expect(owners).toEqual(['r1', 'r1', 'r4']);
    expect(noDevice).toEqual(['r2', 'r3']);
    expect(messages[0]).toMatchObject({
      title: 'Final count: Lunch Tue 10 Nov', body: '42 meals', sound: 'default', priority: 'high', channelId: 'alerts',
      data: { path: '/', outbox_id: 'r1' },
    });
    expect(messages[2]).toMatchObject({ title: 'Tiffin OS', body: '', data: { outbox_id: 'r4' } });
  });

  it('chunks at 100 (the Expo limit)', () => {
    const parts = chunk(Array.from({ length: 250 }, (_, i) => i));
    expect(parts.map((p) => p.length)).toEqual([100, 100, 50]);
    expect(chunk([])).toEqual([]);
  });
});

describe('tickets', () => {
  it('marks a row sent when any device took it, and reports unregistered devices', () => {
    const { messages, owners } = buildMessages([row('r1', [T1, T2]), row('r2', [T3])]);
    const tickets: ExpoTicket[] = [
      { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
      { status: 'ok', id: 'x' },
      { status: 'error', message: 'bad creds', details: { error: 'InvalidCredentials' } },
    ];
    expect(interpretTickets(messages, owners, tickets)).toEqual([
      { id: 'r1', ok: true, error: null, deadTokens: [T1] },
      { id: 'r2', ok: false, error: 'InvalidCredentials', deadTokens: [] },
    ]);
  });

  it('treats a missing ticket as a retryable error', () => {
    const { messages, owners } = buildMessages([row('r1', [T1])]);
    expect(interpretTickets(messages, owners, [])).toEqual([{ id: 'r1', ok: false, error: 'no_ticket', deadTokens: [] }]);
  });
});

describe('sending', () => {
  it('sends nothing in mock mode', async () => {
    const { messages } = buildMessages([row('r1', [T1, T2])]);
    let called = false;
    const tickets = await sendChunk({ mode: 'mock', url: EXPO_PUSH_URL, accessToken: null }, messages, (async () => {
      called = true;
      return new Response('{}');
    }) as typeof fetch);
    expect(called).toBe(false);
    expect(tickets.every((t) => t.status === 'ok')).toBe(true);
  });

  it('posts JSON to Expo (with the access token when set) and reads the tickets', async () => {
    const { messages } = buildMessages([row('r1', [T1])]);
    const cfg = { mode: 'live' as const, url: EXPO_PUSH_URL, accessToken: 'secret' };
    const req = expoRequest(cfg, messages);
    expect(req.url).toBe(EXPO_PUSH_URL);
    expect((req.init.headers as Record<string, string>).Authorization).toBe('Bearer secret');
    expect(JSON.parse(String(req.init.body))).toHaveLength(1);
    const tickets = await sendChunk(cfg, messages, (async () =>
      new Response(JSON.stringify({ data: [{ status: 'ok', id: 'abc' }] }), { status: 200 })) as typeof fetch);
    expect(tickets).toEqual([{ status: 'ok', id: 'abc' }]);
    await expect(sendChunk(cfg, messages, (async () => new Response('down', { status: 503 })) as typeof fetch))
      .rejects.toThrow(/expo_http_503/);
    await expect(sendChunk(cfg, messages, (async () => new Response('{"errors":[{"message":"nope"}]}')) as typeof fetch))
      .rejects.toThrow(/expo_bad_response: nope/);
  });
});
