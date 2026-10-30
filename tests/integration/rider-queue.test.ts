// Unit tests for the rider offline queue helpers (apps/mobile/src/lib/rider-queue.ts; no network):
// sticker scans travel with queued complete_stop actions, and actions saved by older app versions
// (no scanToken field) are still read and sent exactly as before.
import { describe, expect, it } from 'vitest';
import {
  checkScan, completeStopArgs, normalizeScanToken, parseQueue, type QueuedOp,
} from '../../apps/mobile/src/lib/rider-queue.ts';

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
