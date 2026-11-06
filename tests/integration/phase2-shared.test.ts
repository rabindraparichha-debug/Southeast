// Unit tests for the Phase 2 hardening helpers (no network, no DB): the AI budget and Claude call
// (D-128), payment links that fail (D-129), lead-intake keys (D-130). Database sides are in
// supabase/tests/15_phase2_hardening.test.sql.
import { describe, expect, it, vi } from 'vitest';
import { askAi, type AiResult } from '../../supabase/functions/_shared/ai.ts';
import {
  buildAiRequest, DEFAULT_AI_MODEL, loadAiConfig, makeClaudeComplete, parseAiResponse, SDK_RETRY_MS, supportsServerFallback,
  type SdkModule,
} from '../../supabase/functions/_shared/ai-claude.ts';
import { handleMessage, type BotDeps } from '../../supabase/functions/_shared/bot.ts';
import { createLinkOrCancel, failureReason, type LinkSteps } from '../../supabase/functions/_shared/payment-link.ts';
import { cancelPaymentLink, type RazorpayConfig } from '../../supabase/functions/_shared/razorpay.ts';
import {
  checkGoogleKey, checkLeadKey, EXAMPLE_INTAKE_KEYS, intakeKeyProblem, presentedKey,
} from '../../supabase/functions/_shared/leads.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const env = (vars: Record<string, string>) => (k: string) => vars[k];

function ctx(): Json {
  return {
    matched: true, language: 'en', state: {}, handoff_open: false, opted_in: true, today: '2026-11-16',
    customer: { id: 'c1', name: 'Asha Das' },
    kitchen: { id: 'k1', name: 'Maa Tarini Tiffin', cutoff_lunch: '21:00:00', cutoff_lunch_prev_day: true, cutoff_dinner: '12:00:00', cutoff_dinner_prev_day: false },
    balance: { meals: 12, value_paise: 84000 },
    subscriptions: [{ id: 's1', status: 'active', plan: 'Veg Lunch', price_paise: 7000 }],
    meals: [], menus: [],
  };
}

// ---------------------------------------------------------------------------
// AI: config, request, budget, SDK failures
// ---------------------------------------------------------------------------
describe('AI fallback configuration', () => {
  it('reads the model and caps from env, with safe defaults', () => {
    expect(loadAiConfig(env({}))).toEqual({ apiKey: null, model: DEFAULT_AI_MODEL, conversationCap: 5, dayCap: 300, timeoutMs: 8000 });
    expect(loadAiConfig(env({ ANTHROPIC_MODEL: 'claude-sonnet-5-5' })).model).toBe('claude-sonnet-5-5');
    // A chat-only model can be cheaper than the one notebook import uses.
    expect(loadAiConfig(env({ ANTHROPIC_MODEL: 'claude-opus-5-5', ANTHROPIC_CHAT_MODEL: 'claude-haiku-5-5' })).model).toBe('claude-haiku-5-5');
    const c = loadAiConfig(env({ ANTHROPIC_API_KEY: ' sk-ant-x ', AI_CONVERSATION_DAILY_CAP: '2', AI_DAILY_CAP: '50', AI_TIMEOUT_MS: '99' }));
    expect(c).toMatchObject({ apiKey: 'sk-ant-x', conversationCap: 2, dayCap: 50, timeoutMs: 1000 });
    expect(loadAiConfig(env({ AI_DAILY_CAP: 'lots', AI_CONVERSATION_DAILY_CAP: '-3' }))).toMatchObject({ dayCap: 300, conversationCap: 0 });
  });

  it('asks for the refusal fallback only on models that have it', () => {
    expect(supportsServerFallback('claude-opus-5-5')).toBe(true);
    expect(supportsServerFallback('claude-sonnet-5-5')).toBe(true);
    expect(supportsServerFallback('claude-haiku-5-5')).toBe(false);
    const opus = buildAiRequest('claude-opus-5-5', 'sys', 'user');
    expect(opus).toMatchObject({ betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', output_config: { effort: 'low' } });
    const haiku = buildAiRequest('claude-haiku-5-5', 'sys', 'user');
    expect(haiku).not.toHaveProperty('fallbacks');
    expect(haiku).not.toHaveProperty('betas');
    expect((haiku.output_config as Json).format.type).toBe('json_schema');
  });

  it('reads the JSON answer; a refusal or junk hands off', () => {
    const ok: AiResult = { reply: 'Lunch closes at 9 pm the day before.', intent: 'answer', handoff: false };
    expect(parseAiResponse({ stop_reason: 'end_turn', content: [{ type: 'thinking' }, { type: 'text', text: JSON.stringify(ok) }] })).toEqual(ok);
    expect(parseAiResponse({ stop_reason: 'refusal', content: [{ type: 'text', text: JSON.stringify(ok) }] })).toBeNull();
    expect(parseAiResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] })).toBeNull();
    expect(parseAiResponse({ stop_reason: 'end_turn', content: [] })).toBeNull();
  });
});

describe('Claude call', () => {
  const answer = { reply: 'Hello', intent: 'answer', handoff: false };
  function fakeSdk(create: (body: Json) => Promise<unknown>): SdkModule {
    return { default: class { beta = { messages: { create } }; constructor(_o: { apiKey: string }) { void _o; } } } as unknown as SdkModule;
  }

  it('calls the model with the configured model and returns its answer', async () => {
    const bodies: Json[] = [];
    const complete = makeClaudeComplete({
      apiKey: 'k', model: 'claude-haiku-5-5', timeoutMs: 1000,
      importSdk: async () => fakeSdk(async (b) => { bodies.push(b); return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer) }] }; }),
    });
    expect(await complete('sys', 'user')).toEqual(answer);
    expect(bodies[0]).toMatchObject({ model: 'claude-haiku-5-5', system: 'sys' });
  });

  it('hands off cleanly when the SDK cannot be loaded, and does not retry for 10 minutes', async () => {
    let t = 1_000_000;
    const report = vi.fn();
    const importSdk = vi.fn(async (): Promise<SdkModule> => { throw new Error('Module not found: npm:@anthropic-ai/sdk'); });
    const complete = makeClaudeComplete({ apiKey: 'k', model: DEFAULT_AI_MODEL, timeoutMs: 1000, importSdk, report, now: () => t });
    expect(await complete('s', 'u')).toBeNull();
    expect(await complete('s', 'u')).toBeNull();
    expect(importSdk).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]![1]).toBe('ai_sdk_unavailable');
    t += SDK_RETRY_MS + 1;
    expect(await complete('s', 'u')).toBeNull();
    expect(importSdk).toHaveBeenCalledTimes(2);
  });

  it('gives up on a slow or failing call', async () => {
    const report = vi.fn();
    const slow = makeClaudeComplete({ apiKey: 'k', model: DEFAULT_AI_MODEL, timeoutMs: 1000, report,
      importSdk: async () => fakeSdk(() => new Promise((r) => setTimeout(r, 5000))) });
    expect(await slow('s', 'u')).toBeNull();
    expect(report.mock.calls.at(-1)![1]).toBe('ai_timeout');
    const failing = makeClaudeComplete({ apiKey: 'k', model: DEFAULT_AI_MODEL, timeoutMs: 1000, report,
      importSdk: async () => fakeSdk(async () => { throw new Error('529 overloaded'); }) });
    expect(await failing('s', 'u')).toBeNull();
    expect(report.mock.calls.at(-1)![1]).toBe('ai_error');
  });
});

describe('AI budget', () => {
  it('over the cap, the rules answer and the model is not called', async () => {
    const complete = vi.fn(async (): Promise<AiResult> => ({ reply: 'From the model', intent: 'answer', handoff: false }));
    const res = await askAi('what is the cutoff time?', ctx(), 'en', complete, async () => false);
    expect(complete).not.toHaveBeenCalled();
    expect(res).toMatchObject({ intent: 'answer', handoff: false });
    expect(res.reply).toContain('Lunch changes close 21:00 the day before');
    expect(await askAi('tell me a story', ctx(), 'en', complete, async () => false)).toMatchObject({ handoff: true });
  });

  it('a budget that cannot be checked counts as no budget', async () => {
    const complete = vi.fn(async (): Promise<AiResult> => ({ reply: 'x', intent: 'answer', handoff: false }));
    await askAi('tell me a story', ctx(), 'en', complete, async () => { throw new Error('db down'); });
    expect(complete).not.toHaveBeenCalled();
  });

  it('within the cap the model answers', async () => {
    const complete = vi.fn(async (): Promise<AiResult> => ({ reply: 'Your kitchen is Maa Tarini Tiffin.', intent: 'answer', handoff: false }));
    expect((await askAi('which kitchen?', ctx(), 'en', complete, async () => true)).reply).toBe('Your kitchen is Maa Tarini Tiffin.');
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('the bot hands the chat to the kitchen when the budget is spent', async () => {
    const handoffs: string[] = [];
    const complete = vi.fn(async (): Promise<AiResult> => ({ reply: 'x', intent: 'answer', handoff: false }));
    const deps = {
      applyChange: async () => ({ after_cutoff: false, affected: [] }), handoff: async (r: string) => { handoffs.push(r); },
      complaint: async () => 'c', setState: async () => {}, setLanguage: async () => {}, setOptIn: async () => {},
      pageUrl: async () => 'u', paymentLink: async () => ({ url: 'u', amountPaise: 1, meals: 1 }), addLocation: async () => {},
      complete, aiBudget: async () => false,
    } satisfies BotDeps;
    const res = await handleMessage({ kind: 'text', text: 'my neighbour wants to know about festivals' }, ctx(), deps);
    expect(complete).not.toHaveBeenCalled();
    expect(res.intent).toBe('ai_handoff');
    expect(handoffs).toEqual(['question for the kitchen']);
  });
});

// ---------------------------------------------------------------------------
// Payment links: a failed Razorpay call cancels our row
// ---------------------------------------------------------------------------
describe('payment link failures', () => {
  const noSleep = { sleep: async () => {} };
  const steps = (over: Partial<LinkSteps<string>> = {}): LinkSteps<string> => ({
    create: async () => 'https://rzp.io/x',
    attach: async () => {},
    cancelGateway: async () => {},
    ...over,
  });

  it('keeps the row when the link is created and attached', async () => {
    const cancel = vi.fn(async () => true);
    expect(await createLinkOrCancel('p1', steps(), cancel, undefined, noSleep)).toBe('https://rzp.io/x');
    expect(cancel).not.toHaveBeenCalled();
  });

  it('cancels the row and rethrows when Razorpay fails (owner, page, payer and bot paths share this)', async () => {
    const cancel = vi.fn(async () => true);
    const cancelGateway = vi.fn(async () => {});
    await expect(createLinkOrCancel('p1', steps({ create: async () => { throw new Error('razorpay_502: Bad gateway'); }, cancelGateway }),
      cancel, undefined, noSleep)).rejects.toThrow('razorpay_502');
    expect(cancel).toHaveBeenCalledWith('p1', 'razorpay_502');
    expect(cancelGateway).not.toHaveBeenCalled();
  });

  it('a failure to cancel is reported but never hides the original error', async () => {
    const report = vi.fn();
    await expect(createLinkOrCancel('p1', steps({ create: async () => { throw new Error('payments_not_configured: no key'); } }),
      async () => { throw new Error('db down'); }, report, noSleep)).rejects.toThrow('payments_not_configured');
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('retries a failed attach and keeps the row once it works (D-135)', async () => {
    const cancel = vi.fn(async () => true);
    let n = 0;
    const attach = vi.fn(async () => { if (++n < 3) throw new Error('rest_503'); });
    expect(await createLinkOrCancel('p1', steps({ attach }), cancel, undefined, noSleep)).toBe('https://rzp.io/x');
    expect(attach).toHaveBeenCalledTimes(3);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('a link Razorpay created is cancelled there before our row is called failed', async () => {
    const order: string[] = [];
    const cancel = vi.fn(async (_p: string, reason: string) => { order.push(`row:${reason}`); });
    await expect(createLinkOrCancel('p1', steps({
      attach: async () => { throw new Error('rest_503: timeout'); },
      cancelGateway: async (l) => { order.push(`gateway:${l}`); },
    }), cancel, undefined, noSleep)).rejects.toThrow('rest_503');
    expect(order).toEqual(['gateway:https://rzp.io/x', 'row:attach_failed_rest_503']);
  });

  it('if the Razorpay link cannot be cancelled, our row is left as it is (a live link exists) and it is reported', async () => {
    const cancel = vi.fn(async () => true);
    const report = vi.fn();
    await expect(createLinkOrCancel('p1', steps({
      attach: async () => { throw new Error('rest_503'); },
      cancelGateway: async () => { throw new Error('razorpay_500'); },
    }), cancel, report, noSleep)).rejects.toThrow('rest_503');
    expect(cancel).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('cancelling a mock link at the gateway calls nothing', async () => {
    await expect(cancelPaymentLink({ mode: 'mock' } as RazorpayConfig, 'plink_mock_abc')).resolves.toBeUndefined();
  });

  it('keeps only a short reason', () => {
    expect(failureReason(new Error('razorpay_400: {"error":"x"}'))).toBe('razorpay_400');
    expect(failureReason('')).toBe('gateway_error');
    expect(failureReason(new Error('x'.repeat(200))).length).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// Lead intake keys
// ---------------------------------------------------------------------------
describe('lead intake keys', () => {
  const strong = 'k'.repeat(32);
  const strongJd = 'j'.repeat(32);
  const keys = { intake: strong, justdial: strongJd };
  const none = { header: null, basic: null, query: null };

  it('refuses the .env.example values and short keys outside a local stack', () => {
    for (const k of EXAMPLE_INTAKE_KEYS) {
      expect(intakeKeyProblem(k, false)).toBe('example');
      expect(intakeKeyProblem(k, true)).toBeNull();
    }
    expect(intakeKeyProblem('local-dev-anything-at-all-long-enough', false)).toBe('example');
    expect(intakeKeyProblem('short-key', false)).toBe('weak');
    expect(intakeKeyProblem('', true)).toBe('missing');
    expect(intakeKeyProblem(strong, false)).toBeNull();
    expect(checkLeadKey('sulekha', { ...none, header: 'local-dev-lead-key' }, { intake: 'local-dev-lead-key', justdial: '' }, false))
      .toEqual({ ok: false, status: 503, error: 'intake_not_configured' });
    expect(checkGoogleKey('local-dev-google-key', 'local-dev-google-key', false)).toMatchObject({ ok: false, status: 503 });
    expect(checkGoogleKey('local-dev-google-key', 'local-dev-google-key', true)).toMatchObject({ ok: true });
    expect(checkGoogleKey('wrong', strong, false)).toMatchObject({ ok: false, status: 403 });
  });

  it('reads the key from X-Lead-Key or a Basic auth password, and notices ?key=', () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(presentedKey(new URL('https://x/lead-intake?source=sulekha'), h({ 'X-Lead-Key': strong }))).toEqual({ ...none, header: strong });
    const basic = `Basic ${btoa(`leads:${strong}`)}`;
    expect(presentedKey(new URL('https://x/lead-email'), h({ Authorization: basic }))).toEqual({ ...none, basic: strong });
    expect(presentedKey(new URL('https://x/lead-email?key=abc'), h({}))).toEqual({ ...none, query: 'abc' });
    expect(presentedKey(new URL('https://x/lead-email?key='), h({}))).toEqual({ ...none, query: '' });
  });

  it('accepts header keys, refuses keys in the URL except Justdial\'s own key', () => {
    expect(checkLeadKey('sulekha', { ...none, header: strong }, keys, false)).toEqual({ ok: true, via: 'header' });
    expect(checkLeadKey('email', { ...none, basic: strong }, keys, false)).toEqual({ ok: true, via: 'basic' });
    expect(checkLeadKey('sulekha', none, keys, false)).toEqual({ ok: false, status: 401, error: 'key_required' });
    expect(checkLeadKey('sulekha', { ...none, header: 'wrong' }, keys, false)).toMatchObject({ ok: false, status: 403, error: 'forbidden' });
    expect(checkLeadKey('sulekha', { ...none, query: strong }, keys, false)).toEqual({ ok: false, status: 403, error: 'key_in_url' });
    expect(checkLeadKey('email', { ...none, header: strong, query: strong }, keys, false)).toMatchObject({ error: 'key_in_url' });
    expect(checkLeadKey('justdial', { ...none, query: strongJd }, keys, false)).toEqual({ ok: true, via: 'url' });
    // The general key never works in the URL, even for Justdial.
    expect(checkLeadKey('justdial', { ...none, query: strong }, keys, false)).toMatchObject({ ok: false, error: 'forbidden' });
    expect(checkLeadKey('justdial', { ...none, header: strong }, keys, false)).toEqual({ ok: true, via: 'header' });
    expect(checkLeadKey('justdial', { ...none, query: strongJd }, { intake: strong, justdial: '' }, false))
      .toMatchObject({ ok: false, status: 503, error: 'intake_not_configured' });
  });
});
