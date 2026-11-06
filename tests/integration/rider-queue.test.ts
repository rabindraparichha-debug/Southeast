// Unit tests for the rider offline queue helpers (apps/mobile/src/lib/rider-queue.ts and its web twin
// apps/web/src/lib/rider-queue.ts; no network): sticker scans travel with queued complete_stop
// actions, actions saved by older app versions are still read and sent exactly as before, and the
// queue never loses an action: only the rider RPCs' business errors are final (moved to "needs
// attention" with photo and cash), everything else is retried.
import { describe, expect, it } from 'vitest';
import {
  checkScan, completeStopArgs, normalizeScanToken, parseAttention, parseQueue, type QueuedOp,
} from '../../apps/mobile/src/lib/rider-queue.ts';
import * as mobileRules from '../../apps/mobile/src/lib/rider-queue.ts';
import * as webRules from '../../apps/web/src/lib/rider-queue.ts';

const base: QueuedOp = {
  op: '6f1c2b1e-1111-4222-8333-444455556666',
  kind: 'complete',
  runId: 'run-1',
  stopId: 'stop-1',
  at: '2026-11-05T07:10:00.000Z',
  offline: true,
  args: { p_proof: 'none', p_otp: null, p_tiffins_out: 1, p_tiffins_returned: 0, p_cash_paise: 0 },
};

describe('sticker codes', () => {
  it('reads the code like private.scan_token', () => {
    expect(normalizeScanToken('TFN:abcd23efgh')).toBe('ABCD23EFGH');
    expect(normalizeScanToken('https://app.example.in/t/ABCD23EFGH')).toBe('ABCD23EFGH');
    expect(normalizeScanToken('https://app.example.in/t?code=ABCD23EFGH')).toBe('ABCD23EFGH');
    expect(normalizeScanToken(' abcd-23ef gh ')).toBe('ABCD23EFGH');
    expect(normalizeScanToken('')).toBeNull();
    expect(normalizeScanToken('TFN:')).toBeNull();
    expect(normalizeScanToken(undefined)).toBeNull();
  });

  it('checks a scan against the cached stop code (offline)', () => {
    expect(checkScan('ABCD23EFGH', 'TFN:ABCD23EFGH')).toBe('ok');
    expect(checkScan('ABCD23EFGH', 'TFN:ZZZZ23EFGH')).toBe('wrong');
    expect(checkScan(undefined, 'TFN:ABCD23EFGH')).toBe('unknown'); // cache from an older version
    expect(checkScan('ABCD23EFGH', '---')).toBe('empty');
  });
});

describe('complete_stop arguments from the queue', () => {
  it('sends the scanned code with the queued action', () => {
    const args = completeStopArgs({ ...base, scanToken: 'TFN:abcd23efgh' });
    expect(args).toMatchObject({
      p_stop: 'stop-1', p_proof: 'none', p_at: base.at, p_client_op: base.op, p_offline: true, p_scan_token: 'ABCD23EFGH',
    });
  });

  it('leaves p_scan_token out for actions without a scan (older app versions)', () => {
    const args = completeStopArgs(base);
    expect('p_scan_token' in args).toBe(false);
    expect(args).toEqual({
      ...base.args, p_stop: 'stop-1', p_at: base.at, p_client_op: base.op, p_offline: true, p_photo_path: undefined,
    });
  });

  it('a scan survives saving and reloading the queue (app restart)', () => {
    const saved = JSON.stringify([{ ...base, scanToken: 'ABCD23EFGH', photoPath: 'k/2026-11-05/stop-1.jpg' }]);
    const q = parseQueue(saved)[0]!;
    expect(q.scanToken).toBe('ABCD23EFGH');
    expect(completeStopArgs(q)).toMatchObject({ p_scan_token: 'ABCD23EFGH', p_photo_path: 'k/2026-11-05/stop-1.jpg' });
  });
});

describe('reading the saved queue', () => {
  it('reads actions saved by an older app version unchanged', () => {
    const old = [
      { op: 'a', kind: 'start', runId: 'run-1', at: base.at, offline: true, args: {} },
      { op: 'b', kind: 'complete', runId: 'run-1', stopId: 'stop-1', at: base.at, offline: true, args: base.args },
    ];
    const q = parseQueue(JSON.stringify(old));
    expect(q).toEqual(old);
    expect(q[1]!.scanToken).toBeUndefined();
  });

  it('never crashes on a missing or damaged queue', () => {
    expect(parseQueue(null)).toEqual([]);
    expect(parseQueue('not json')).toEqual([]);
    expect(parseQueue('{"op":"a"}')).toEqual([]);
    expect(parseQueue(JSON.stringify([null, 3, { op: 'x' }, { op: 'y', kind: 'finish', runId: 'r' }]))).toEqual([
      { op: 'y', kind: 'finish', runId: 'r', args: {} },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Never lose a rider action (mobile and web share the same rules)
// ---------------------------------------------------------------------------
const NOW = Date.parse('2026-11-06T07:00:00.000Z');

// Every code the rider RPCs raise for a request that can never succeed as it is
// (start_run, complete_stop, fail_stop, finish_run, private.require_run_access).
const BUSINESS = [
  'not_found', 'forbidden', 'wrong_tiffin', 'invalid_client_op', 'proof_required', 'photo_required', 'invalid_photo',
  'invalid_amount', 'otp_locked', 'reason_required', 'note_required', 'stops_pending',
];

// What supabase-js hands back for temporary failures: these must never drop the action.
const TEMPORARY: [string, mobileRules.ErrorLike, boolean][] = [
  ['503 from the gateway', { message: 'Service Unavailable', status: 503 }, false],
  ['PGRST002 schema cache', { code: 'PGRST002', message: 'Could not query the database for the schema cache. Retrying.', status: 503 }, false],
  ['PGRST000 database down', { code: 'PGRST000', message: 'Database connection error. Retrying the connection.', status: 503 }, false],
  ['PGRST301 expired JWT', { code: 'PGRST301', message: 'JWT expired', status: 401 }, false],
  ['57014 statement timeout', { code: '57014', message: 'canceling statement due to statement timeout', status: 500 }, false],
  ['anonymous after a failed token refresh', { code: '42501', message: 'permission denied for function complete_stop', status: 401 }, false],
  ['not_authenticated from the RPC', { code: '28000', message: 'not_authenticated', status: 401 }, false],
  ['500 with no code', { message: 'Internal Server Error', status: 500 }, false],
  ['429 rate limit', { message: 'Too Many Requests', status: 429 }, false],
  ['no network (React Native)', { message: 'TypeError: Network request failed', code: '', status: 0 }, true],
  ['no network (browser)', { message: 'TypeError: Failed to fetch', code: '', status: 0 }, true],
  ['request timed out (abort)', { message: 'AbortError: Aborted', code: '20', status: 0 }, true],
  ['withTimeout gave up', { message: 'timeout', name: 'TimeoutError' }, true],
  ['storage upload without network', { message: 'Network request failed', name: 'StorageUnknownError' }, true],
];

describe.each([['mobile', mobileRules], ['web', webRules]] as const)('%s queue: error classification', (_app, m) => {
  const q = { ...base, tries: undefined } as QueuedOp;

  it('lists exactly the rider RPC business errors as final', () => {
    expect([...m.FINAL_ERRORS].sort()).toEqual([...BUSINESS].sort());
  });

  it.each(BUSINESS)('business error %s is final: moved to needs attention at once', (code) => {
    const v = m.classifyError({ message: code, code: code === 'forbidden' ? '42501' : code === 'not_found' ? 'P0002' : '22023', status: 400 });
    expect(v).toEqual({ kind: 'final', reason: code });
    expect(m.afterFailure(q, v, NOW)).toEqual({ park: true, reason: code });
  });

  it.each(TEMPORARY)('%s is kept and retried with backoff, however long it lasts', (_name, error, network) => {
    const v = m.classifyError(error);
    expect(v.kind).toBe('wait');
    expect(v.kind === 'wait' && v.network).toBe(network);
    const after = m.afterFailure({ ...q, tries: 500 }, v, NOW);
    expect(after.park).toBe(false);
    if (!after.park) {
      expect(after.op.tries).toBe(501);
      expect(Date.parse(after.op.nextAt!)).toBe(NOW + 5 * 60_000);
      expect(after.op.op).toBe(q.op); // same client id: a retry can never count twice
      expect(after.op.args).toEqual(q.args); // the cash amount travels with it
    }
  });

  it('413 (photo too large) is kept and retried, then parked in needs attention, never dropped', () => {
    const v = m.classifyError({ message: 'The object exceeded the maximum allowed size', statusCode: '413', status: 413 });
    expect(v.kind).toBe('retry');
    const first = m.afterFailure(q, v, NOW);
    expect(first).toMatchObject({ park: false, op: { tries: 1, lastError: 'The object exceeded the maximum allowed size' } });
    if (!first.park) expect(Date.parse(first.op.nextAt!)).toBe(NOW + 2_000);
    expect(m.afterFailure({ ...q, tries: m.MAX_TRIES - 2 }, v, NOW).park).toBe(false);
    expect(m.afterFailure({ ...q, tries: m.MAX_TRIES - 1 }, v, NOW)).toEqual({ park: true, reason: 'The object exceeded the maximum allowed size' });
  });

  it('unknown errors are retried too, not dropped', () => {
    expect(m.classifyError({ message: 'Could not find the function public.complete_stop', code: 'PGRST202', status: 404 }).kind).toBe('retry');
    expect(m.classifyError({ message: 'something odd' }).kind).toBe('retry');
    expect(m.classifyError(null).kind).toBe('retry');
  });

  it('backs off 2 s, 4 s, 8 s … up to 5 minutes, and waits for it', () => {
    expect([1, 2, 3, 4, 9, 10, 50].map(m.backoffMs)).toEqual([2_000, 4_000, 8_000, 16_000, 300_000, 300_000, 300_000]);
    expect(m.isDue(q, NOW)).toBe(true);
    expect(m.isDue({ ...q, nextAt: new Date(NOW + 1_000).toISOString() }, NOW)).toBe(false);
    expect(m.isDue({ ...q, nextAt: new Date(NOW - 1).toISOString() }, NOW)).toBe(true);
    expect(m.isDue({ ...q, nextAt: 'garbage' }, NOW)).toBe(true);
  });

  it('answers that look like success but would lose the record are not success', () => {
    const otp = { ...q, args: { ...q.args, p_proof: 'otp', p_otp: '1234' } };
    expect(m.judgeResult(otp, { stop_id: 's', status: 'pending', otp_ok: false, conflict: false })).toEqual({ ok: false, reason: 'otp_wrong' });
    expect(m.judgeResult(q, { stop_id: 's', status: 'delivered', otp_ok: null, conflict: false })).toEqual({ ok: true });
    // Someone else marked the stop first: fine unless this action carried cash or a different outcome.
    expect(m.judgeResult(q, { status: 'delivered', conflict: true })).toEqual({ ok: true });
    expect(m.judgeResult({ ...q, args: { ...q.args, p_cash_paise: 50000 } }, { status: 'delivered', conflict: true }))
      .toEqual({ ok: false, reason: 'already_done' });
    expect(m.judgeResult(q, { status: 'failed', conflict: true })).toEqual({ ok: false, reason: 'already_done' });
    expect(m.judgeResult({ ...q, kind: 'fail', args: { p_reason: 'not_home' } }, { status: 'failed', conflict: true })).toEqual({ ok: true });
    expect(m.judgeResult({ ...q, kind: 'start' }, null)).toEqual({ ok: true });
    expect(m.cashOf({ ...q, args: { p_cash_paise: 50000 } })).toBe(50000);
    expect(m.cashOf({ ...q, args: {} })).toBe(0);
  });

  it('a parked action goes back to the queue with a fresh retry count and the same client id', () => {
    const parked = { op: { ...q, tries: 9, nextAt: new Date(NOW).toISOString(), lastError: 'x', photoPath: 'k/p.jpg' }, reason: 'forbidden', at: base.at };
    const back = m.requeue(parked);
    expect(back).toEqual({ ...q, photoPath: 'k/p.jpg' });
    expect('tries' in back || 'nextAt' in back || 'lastError' in back).toBe(false);
  });

  it('withTimeout gives up with an error the queue treats as "no network"', async () => {
    const err = await m.withTimeout(new Promise(() => undefined), 5).catch((e: Error) => e);
    expect(m.classifyError(err as Error)).toEqual({ kind: 'wait', reason: 'network', network: true });
    await expect(m.withTimeout(Promise.resolve(7), 50)).resolves.toBe(7);
  });
});

describe('saved queue and needs-attention list survive a restart', () => {
  it('actions from older app versions (no retry fields) are due and retried normally', () => {
    const [old] = parseQueue(JSON.stringify([{ op: 'a', kind: 'complete', runId: 'r', stopId: 's', at: base.at, offline: true, args: base.args }]));
    expect(mobileRules.isDue(old!, NOW)).toBe(true);
    const after = mobileRules.afterFailure(old!, { kind: 'wait', reason: 'network', network: true }, NOW);
    expect(after).toMatchObject({ park: false, op: { op: 'a', tries: 1 } });
    const [webOld] = webRules.sanitizeQueue([{ op: 'a', kind: 'finish', runId: 'r', at: base.at, offline: false, args: {}, hasPhoto: false }]);
    expect(webRules.isDue(webOld!, NOW)).toBe(true);
  });

  it('refused actions keep their photo and cash across a restart (mobile JSON, web IndexedDB)', () => {
    const item = { op: { ...base, photoUri: 'file:///proofs/x.jpg', photoPath: 'k/2026-11-05/s.jpg', args: { ...base.args, p_cash_paise: 120000 } }, reason: 'forbidden', at: base.at };
    const [m] = parseAttention(JSON.stringify([item]));
    expect(m).toEqual(item);
    expect(mobileRules.cashOf(m!.op)).toBe(120000);
    const [w] = webRules.sanitizeAttention([{ ...item, op: { ...item.op, photoUri: undefined, hasPhoto: true } }]);
    expect(w!.op).toMatchObject({ hasPhoto: true, photoPath: 'k/2026-11-05/s.jpg' });
    expect(parseAttention('not json')).toEqual([]);
    expect(parseAttention(JSON.stringify([null, { reason: 'x' }, { op: { op: 'y' } }]))).toEqual([]);
    expect(webRules.sanitizeAttention('nope')).toEqual([]);
  });
});
