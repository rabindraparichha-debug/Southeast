// Unit tests for Edge Function error reporting (no network).
import { describe, expect, it } from 'vitest';
import { buildEnvelope, parseDsn, reportError, scrub } from '../../supabase/functions/_shared/monitor.ts';

const cfg = { dsn: 'https://abc123@o1.ingest.sentry.io/4242', environment: 'test', release: 'r1' };

describe('Edge Function monitoring', () => {
  it('parses a DSN', () => {
    expect(parseDsn(cfg.dsn)).toEqual({ protocol: 'https', key: 'abc123', host: 'o1.ingest.sentry.io', projectId: '4242' });
    expect(parseDsn('')).toBeNull();
    expect(parseDsn('not a dsn')).toBeNull();
  });

  it('masks phone numbers anywhere in the report', () => {
    expect(scrub('customer +91 98610 00002 failed')).toBe('customer [phone] failed');
    expect(scrub('wa 919861000002')).toBe('wa [phone]');
    const env = buildEnvelope(cfg, new Error('send to 9861000002 failed'), { fn: 'whatsapp-outbox', extra: { to: '+919861000002', id: 'x1' } },
      new Date('2026-11-02T10:00:00Z'), 'e1');
    expect(env).not.toMatch(/9861000002/);
    expect(env).toContain('[phone]');
  });

  it('builds a Sentry envelope with the function as a tag', () => {
    const lines = buildEnvelope(cfg, new TypeError('boom'), { fn: 'razorpay-webhook', tags: { code: 'db_error' } },
      new Date('2026-11-02T10:00:00Z'), 'e2').split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!)).toMatchObject({ event_id: 'e2', dsn: cfg.dsn });
    expect(JSON.parse(lines[1]!)).toEqual({ type: 'event' });
    const ev = JSON.parse(lines[2]!);
    expect(ev).toMatchObject({ level: 'error', environment: 'test', release: 'r1', tags: { function: 'razorpay-webhook', code: 'db_error' } });
    expect(ev.exception.values[0]).toMatchObject({ type: 'TypeError', value: 'boom' });
  });

  it('sends nothing without a DSN and never throws', async () => {
    let calls = 0;
    const fetchFn = (async () => { calls++; throw new Error('network down'); }) as unknown as typeof fetch;
    await reportError({ dsn: null, environment: 'x' }, new Error('e'), { fn: 'f' }, fetchFn);
    expect(calls).toBe(0);
    await expect(reportError(cfg, new Error('e'), { fn: 'f' }, fetchFn)).resolves.toBeUndefined();
    expect(calls).toBe(1);
  });
});
