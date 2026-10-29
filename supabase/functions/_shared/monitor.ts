// Error reporting from Edge Functions to Sentry, without the SDK (one small fetch per error).
// No-op unless SENTRY_DSN is set. Never pass phone numbers, names or message bodies: only codes,
// ids and the function name (privacy rule; phones are encrypted at rest for a reason).
// No external imports, so it is unit-testable from Node (tests/integration/monitor.test.ts).

export type MonitorConfig = { dsn: string | null; environment: string; release?: string };

type Dsn = { key: string; host: string; projectId: string; protocol: string };

export function parseDsn(dsn: string | null | undefined): Dsn | null {
  if (!dsn) return null;
  const m = /^(https?):\/\/([^@]+)@([^/]+)\/(\d+)$/.exec(dsn.trim());
  if (!m) return null;
  return { protocol: m[1]!, key: m[2]!, host: m[3]!, projectId: m[4]! };
}

const PHONE = /(\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}/g;
/** Last line of defence: mask anything that looks like an Indian mobile number. */
export function scrub(text: string): string {
  return text.replace(PHONE, '[phone]');
}

function uuid32(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** A Sentry envelope (https://develop.sentry.dev/sdk/envelopes/) for one error event. */
export function buildEnvelope(
  cfg: MonitorConfig, error: unknown, context: { fn: string; tags?: Record<string, string>; extra?: Record<string, unknown> },
  now = new Date(), eventId = uuid32(),
): string {
  const e = error instanceof Error ? error : new Error(String(error));
  const event = {
    event_id: eventId,
    timestamp: now.toISOString(),
    platform: 'javascript',
    level: 'error',
    environment: cfg.environment,
    ...(cfg.release ? { release: cfg.release } : {}),
    server_name: context.fn,
    tags: { function: context.fn, ...(context.tags ?? {}) },
    extra: JSON.parse(scrub(JSON.stringify(context.extra ?? {}))),
    exception: { values: [{ type: e.name || 'Error', value: scrub(e.message), stacktrace: e.stack ? {
      frames: e.stack.split('\n').slice(1, 30).reverse().map((l) => ({ function: scrub(l.trim()) })),
    } : undefined }] },
  };
  return [
    JSON.stringify({ event_id: eventId, sent_at: now.toISOString(), dsn: cfg.dsn }),
    JSON.stringify({ type: 'event' }),
    JSON.stringify(event),
  ].join('\n');
}

export function loadMonitorConfig(env: (k: string) => string | undefined): MonitorConfig {
  return { dsn: env('SENTRY_DSN') ?? null, environment: env('SENTRY_ENVIRONMENT') ?? 'local', release: env('SENTRY_RELEASE') };
}

/** Reports an error; never throws (monitoring must not break the request). */
export async function reportError(
  cfg: MonitorConfig, error: unknown, context: { fn: string; tags?: Record<string, string>; extra?: Record<string, unknown> },
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const d = parseDsn(cfg.dsn);
  if (!d) return;
  try {
    await fetchFn(`${d.protocol}://${d.host}/api/${d.projectId}/envelope/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-sentry-envelope',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${d.key}, sentry_client=tiffin-edge/1.0`,
      },
      body: buildEnvelope(cfg, error, context),
    });
  } catch {
    // ignore
  }
}
