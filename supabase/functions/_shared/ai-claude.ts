// The Claude call behind the chat fallback (D-058, D-148). No external imports: the SDK is passed in
// as an importer by whatsapp-webhook/index.ts (a Deno `npm:` import), so this file is unit-tested
// from Node with a fake SDK.
//
// - Model: ANTHROPIC_CHAT_MODEL, else ANTHROPIC_MODEL (shared with notebook import), else
//   claude-opus-5-5 (D-058 is the owner's cost decision; a cheaper model is one secret away).
// - Caps: AI_CONVERSATION_DAILY_CAP (default 5 model calls per conversation per IST day) and
//   AI_DAILY_CAP (default 300 for the whole platform), enforced by wa_ai_take in the database.
// - Robust: if the SDK cannot be loaded, the call is skipped for 10 minutes (one error report) and
//   the chat is handed to the kitchen; a slow call is abandoned after AI_TIMEOUT_MS.

import { AI_OUTPUT_SCHEMA, type AiResult, type Complete } from './ai.ts';

type Env = (name: string) => string | undefined;

export const DEFAULT_AI_MODEL = 'claude-opus-5-5';

export type AiConfig = {
  apiKey: string | null;
  model: string;
  conversationCap: number;
  dayCap: number;
  timeoutMs: number;
};

function intEnv(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = (env(name) ?? '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function loadAiConfig(env: Env): AiConfig {
  const apiKey = (env('ANTHROPIC_API_KEY') ?? '').trim() || null;
  const model = (env('ANTHROPIC_CHAT_MODEL') ?? '').trim() || (env('ANTHROPIC_MODEL') ?? '').trim() || DEFAULT_AI_MODEL;
  return {
    apiKey,
    model,
    conversationCap: intEnv(env, 'AI_CONVERSATION_DAILY_CAP', 5, 0, 100),
    dayCap: intEnv(env, 'AI_DAILY_CAP', 300, 0, 100_000),
    timeoutMs: intEnv(env, 'AI_TIMEOUT_MS', 8000, 1000, 30_000),
  };
}

/** Models that accept Anthropic's server-side refusal fallback (`fallbacks: "default"`). Haiku does not. */
export function supportsServerFallback(model: string): boolean {
  return /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/.test(model);
}

/** The request body: low effort, structured JSON output, and the refusal fallback where the model has it. */
export function buildAiRequest(model: string, system: string, user: string): Record<string, unknown> {
  return {
    model,
    max_tokens: 1024,
    ...(supportsServerFallback(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
    output_config: { effort: 'low', format: { type: 'json_schema', schema: AI_OUTPUT_SCHEMA } },
    system,
    messages: [{ role: 'user', content: user }],
  };
}

type Response_ = { stop_reason?: string; content?: { type: string; text?: string }[] };
type Client = { beta: { messages: { create: (body: never) => Promise<Response_> } } };
export type SdkModule = { default: new (opts: { apiKey: string }) => Client };

/** Reads the model's JSON answer; null for a refusal or anything unreadable (the caller hands off). */
export function parseAiResponse(res: Response_ | null | undefined): AiResult | null {
  if (!res || res.stop_reason === 'refusal') return null;
  const text = res.content?.find((b) => b.type === 'text')?.text;
  if (!text) return null;
  try {
    const v = JSON.parse(text) as AiResult;
    return v && typeof v === 'object' && typeof v.reply === 'string' ? v : null;
  } catch {
    return null;
  }
}

export const SDK_RETRY_MS = 10 * 60_000;

export function makeClaudeComplete(opts: {
  apiKey: string;
  model: string;
  timeoutMs: number;
  importSdk: () => Promise<SdkModule>;
  report?: (e: unknown, code: string) => void;
  now?: () => number;
}): Complete {
  const now = opts.now ?? Date.now;
  let client: Client | null = null;
  let blockedUntil = 0;

  async function getClient(): Promise<Client | null> {
    if (client) return client;
    if (now() < blockedUntil) return null;
    try {
      const mod = await opts.importSdk();
      client = new mod.default({ apiKey: opts.apiKey });
      return client;
    } catch (e) {
      blockedUntil = now() + SDK_RETRY_MS;
      opts.report?.(e, 'ai_sdk_unavailable');
      return null;
    }
  }

  return async (system, user) => {
    const c = await getClient();
    if (!c) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const res = await Promise.race([
        c.beta.messages.create(buildAiRequest(opts.model, system, user) as never),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('ai_timeout')), opts.timeoutMs); }),
      ]);
      return parseAiResponse(res);
    } catch (e) {
      opts.report?.(e, String((e as Error)?.message) === 'ai_timeout' ? 'ai_timeout' : 'ai_error');
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
