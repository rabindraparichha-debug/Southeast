// Error reporting to Sentry through its plain HTTP envelope API, without the SDK (D-092).
// Mirrors supabase/functions/_shared/monitor.ts and apps/mobile/src/lib/monitor.ts.
// - No-op unless NEXT_PUBLIC_SENTRY_DSN is set (it is inlined at build time, so set it before `next build`).
// - Works on the server (instrumentation.ts onRequestError) and in the browser (error boundaries,
//   window error / unhandledrejection listeners).
// - Never pass names, phone numbers or message bodies. As a last line of defence anything that looks
//   like an Indian mobile number is masked, and customer magic-link tokens (/c/<token>) are removed.

export type ErrorContext = {
  /** Where it was caught: 'server', 'boundary', 'global-boundary', 'window'. */
  source: string;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
};

type Dsn = { protocol: string; key: string; host: string; projectId: string };

export function parseDsn(dsn: string | null | undefined): Dsn | null {
  if (!dsn) return null;
  const m = /^(https?):\/\/([^@]+)@([^/]+)\/(\d+)$/.exec(dsn.trim());
  if (!m) return null;
  return { protocol: m[1]!, key: m[2]!, host: m[3]!, projectId: m[4]! };
}

const PHONE = /(\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}/g;
const PORTAL_TOKEN = /\/c\/[^/?#\s"'\\]+/g;

/** Masks Indian mobile numbers and customer-page tokens. */
export function scrub(text: string): string {
  return text.replace(PORTAL_TOKEN, '/c/[token]').replace(PHONE, '[phone]');
}

function eventId(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function config() {
  return {
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN ?? '',
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
  };
}

export function monitoringEnabled(): boolean {
  return parseDsn(config().dsn) !== null;
}

/** A Sentry envelope (https://develop.sentry.dev/sdk/envelopes/) holding one error event. */
export function buildEnvelope(
  dsn: string, error: unknown, context: ErrorContext,
  opts: { environment?: string; release?: string; now?: Date; id?: string } = {},
): string {
  const e = error instanceof Error ? error : new Error(typeof error === 'string' ? error : safeString(error));
  const now = opts.now ?? new Date();
  const id = opts.id ?? eventId();
  const digest = typeof error === 'object' && error !== null && 'digest' in error ? String((error as { digest: unknown }).digest) : undefined;
  const event = {
    event_id: id,
    timestamp: now.toISOString(),
    platform: 'javascript',
    level: 'error',
    logger: 'tiffin-web',
    environment: opts.environment ?? 'development',
    ...(opts.release ? { release: opts.release } : {}),
    tags: { app: 'web', source: context.source, ...(digest ? { digest } : {}), ...scrubRecord(context.tags ?? {}) },
    extra: JSON.parse(scrub(JSON.stringify(context.extra ?? {}))),
    exception: {
      values: [{
        type: e.name || 'Error',
        value: scrub(e.message),
        stacktrace: e.stack
          ? { frames: e.stack.split('\n').slice(1, 30).reverse().map((l) => ({ function: scrub(l.trim()) })) }
          : undefined,
      }],
    },
  };
  return [
    JSON.stringify({ event_id: id, sent_at: now.toISOString(), dsn }),
    JSON.stringify({ type: 'event' }),
    JSON.stringify(event),
  ].join('\n');
}

function scrubRecord(r: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, scrub(String(v)).slice(0, 200)]));
}

function safeString(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Reports an error. Never throws: monitoring must not break the page or the request. */
export async function reportError(error: unknown, context: ErrorContext, fetchFn: typeof fetch = fetch): Promise<void> {
  const cfg = config();
  const d = parseDsn(cfg.dsn);
  if (!d) return;
  try {
    await fetchFn(`${d.protocol}://${d.host}/api/${d.projectId}/envelope/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-sentry-envelope',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${d.key}, sentry_client=tiffin-web/1.0`,
      },
      body: buildEnvelope(cfg.dsn, error, context, { environment: cfg.environment, release: cfg.release }),
      keepalive: true,
    });
  } catch {
    // ignore
  }
}
