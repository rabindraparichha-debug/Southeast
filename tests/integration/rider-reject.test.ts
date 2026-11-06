// Unit tests for the report of a refused rider action (apps/mobile/src/lib/rider-reject.ts and its
// web twin; no network). The report carries what the owner needs (kitchen, run, stop, cash, labels)
// and never the photo, its path, the delivery code or a phone number; only network/busy failures
// keep a report for later; the pending list is bounded. D-126.
import { describe, expect, it } from 'vitest';
import * as mobile from '../../apps/mobile/src/lib/rider-reject.ts';
import * as web from '../../apps/web/src/lib/rider-reject.ts';
import type { AttentionItem } from '../../apps/mobile/src/lib/rider-queue.ts';

const KITCHEN = '10000000-0000-4000-a000-00000000000a';
const RUN = '20000000-0000-4000-a000-000000000001';
const STOP = '30000000-0000-4000-a000-000000000001';
const OP = '6f1c2b1e-1111-4222-8333-444455556666';

const runs: mobile.RunInfo[] = [{
  id: RUN, kitchen_id: KITCHEN, route_name: 'Patia', service_date: '2026-11-16', slot: 'lunch',
  stops: [{ id: STOP, name: 'Ramesh Panda' }],
}];

const item: AttentionItem = {
  op: {
    op: OP, kind: 'complete', runId: RUN, stopId: STOP, at: '2026-11-16T06:40:00.000Z', offline: true,
    photoUri: 'file:///data/proofs/x.jpg', photoPath: `${KITCHEN}/2026-11-16/${STOP}-6f1c2b1e.jpg`, scanToken: 'ABCD23EFGH',
    args: { p_proof: 'otp', p_otp: '4321', p_lat: 20.35, p_lng: 85.82, p_accuracy: 12, p_tiffins_out: 2, p_tiffins_returned: 1, p_cash_paise: 25000 },
  },
  reason: 'already_done',
  at: '2026-11-16T06:50:00.000Z',
};

for (const [name, lib] of [['mobile', mobile], ['web', web]] as const) {
  describe(`${name} rider-reject`, () => {
    it('builds the report from the parked action and the cached run', () => {
      expect(lib.rejectReport(item, runs)).toEqual({
        p_client_op: OP, p_kind: 'complete', p_error: 'already_done', p_kitchen: KITCHEN, p_run: RUN, p_stop: STOP,
        p_summary: {
          proof: 'otp', reason: undefined, note: undefined, tiffins_out: 2, tiffins_returned: 1, gps: true, offline: true,
          scanned: true, stop_label: 'Ramesh Panda', route_label: 'Patia', service_date: '2026-11-16', slot: 'lunch',
        },
        p_cash_paise: 25000, p_had_photo: true, p_acted_at: '2026-11-16T06:40:00.000Z', p_refused_at: '2026-11-16T06:50:00.000Z',
      });
    });

    it('never sends the delivery code, the photo or its path', () => {
      const json = JSON.stringify(lib.rejectReport(item, runs));
      expect(json).not.toContain('4321');
      expect(json).not.toContain('file://');
      expect(json).not.toContain('.jpg');
      expect(json).not.toContain('ABCD23EFGH');
    });

    it('works when the run is no longer cached: kitchen from the photo path, else left to the server', () => {
      const r = lib.rejectReport(item, []);
      expect(r?.p_kitchen).toBe(KITCHEN);
      expect(r?.p_summary.stop_label).toBeUndefined();
      const fail: AttentionItem = {
        op: { op: OP, kind: 'fail', runId: RUN, stopId: STOP, at: item.op.at, offline: false, args: { p_reason: 'not_home', p_note: 'gate locked' } },
        reason: 'not_found', at: item.at,
      };
      const f = lib.rejectReport(fail, []);
      expect(f?.p_kitchen).toBeUndefined();
      expect(f?.p_summary).toMatchObject({ reason: 'not_home', note: 'gate locked', gps: false });
      expect(f?.p_cash_paise).toBe(0);
      expect(f?.p_had_photo).toBe(false);
    });

    it('skips actions saved without a proper client id (very old versions)', () => {
      expect(lib.rejectReport({ ...item, op: { ...item.op, op: 'legacy-1' } }, runs)).toBeNull();
    });

    it('keeps a report only while the server cannot be reached or is busy', () => {
      expect(lib.keepReport({ message: 'Network request failed', status: 0 })).toBe(true);
      expect(lib.keepReport({ message: 'x', code: '57014' })).toBe(true);
      expect(lib.keepReport({ message: 'JWT expired', code: 'PGRST301', status: 401 })).toBe(true);
      expect(lib.keepReport({ message: 'forbidden', code: '42501', status: 403 })).toBe(false);
      expect(lib.keepReport({ message: 'Could not find the function', code: 'PGRST202', status: 404 })).toBe(false);
    });

    it('bounds the pending list: one per refusal, newest kept, nothing older than a week', () => {
      const now = Date.parse('2026-11-16T07:00:00.000Z');
      const r = lib.rejectReport(item, runs)!;
      const old = { ...r, p_client_op: '7f1c2b1e-1111-4222-8333-444455556666', p_refused_at: '2026-11-01T00:00:00.000Z' };
      const many = Array.from({ length: 60 }, (_, i) => ({ ...r, p_refused_at: new Date(now - (60 - i) * 1000).toISOString() }));
      const out = lib.trimReports([old, r, r, ...many], now);
      expect(out).toHaveLength(lib.MAX_PENDING_REPORTS);
      expect(out.at(-1)).toBe(many.at(-1)); // the objects themselves are kept
      expect(out).not.toContain(old);
      expect(lib.trimReports([r, r], now)).toEqual([r]);
    });

    it('reads saved reports defensively', () => {
      const r = lib.rejectReport(item, runs)!;
      expect(lib.sanitizeReports([r, null, { p_client_op: 'x' }, 'junk'])).toEqual([r]);
      expect(lib.sanitizeReports('nope')).toEqual([]);
    });
  });
}
