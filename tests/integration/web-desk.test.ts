// Unit tests for the web phone desk, customer search and closure rules (apps/web/src/lib/desk-rules.ts;
// no network): Undo targets the skip or pause that actually holds a meal, digits search the flat as
// well as the phone ending, a meal out with the rider can still be skipped while its stop is
// pending, and "Close tomorrow" never asks for a meal already past its cutoff.
import { describe, expect, it } from 'vitest';
import {
  cellActions, coveringHolds, opensSingleMatch, queryKind, quickClosure, searchOrFilter, type HoldLike,
} from '../../apps/web/src/lib/desk-rules.ts';

const SUB = 'sub-1';
const hold = (h: Partial<HoldLike> & Pick<HoldLike, 'change_id' | 'from_date' | 'requested_at'>): HoldLike => ({
  subscription_id: SUB, to_date: h.from_date, slot: null, resumed_from: null, ...h,
});

describe('customer search', () => {
  it('reads full numbers, bare digits and text', () => {
    expect(queryKind('')).toBe('empty');
    expect(queryKind('  ')).toBe('empty');
    expect(queryKind('98765 43210')).toBe('phone');
    expect(queryKind('+91 98765-43210')).toBe('phone');
    expect(queryKind('402')).toBe('digits');
    expect(queryKind('4021')).toBe('digits');
    expect(queryKind('987654')).toBe('digits');
    expect(queryKind('Flat 402')).toBe('text');
    expect(queryKind('Ravi')).toBe('text');
  });

  it('searches the flat for a flat number, and the phone ending only for exactly 4 digits', () => {
    // A caller says "flat 402": the address is searched (the old code looked only at phone endings).
    expect(searchOrFilter('402')).toBe('name.ilike.*402*,line1.ilike.*402*,area.ilike.*402*,landmark.ilike.*402*');
    expect(searchOrFilter('13')).toContain('line1.ilike.*13*');
    expect(searchOrFilter('13')).not.toContain('phone_last4');
    // Exactly 4 digits: the flat or the last 4 digits of the number (as search_customers did).
    expect(searchOrFilter('4021')).toBe(
      'name.ilike.*4021*,line1.ilike.*4021*,area.ilike.*4021*,landmark.ilike.*4021*,phone_last4.eq.4021',
    );
    expect(searchOrFilter('987654')).not.toContain('phone_last4');
  });

  it('keeps text search as before and leaves full numbers to the hash lookup', () => {
    expect(searchOrFilter('Sai Residency')).toBe(
      'name.ilike.*Sai Residency*,line1.ilike.*Sai Residency*,area.ilike.*Sai Residency*,landmark.ilike.*Sai Residency*',
    );
    // PostgREST filter syntax characters are stripped, never passed through.
    expect(searchOrFilter('a,b(c)*d%e"f:g')).toBe(
      'name.ilike.*a b c d e f g*,line1.ilike.*a b c d e f g*,area.ilike.*a b c d e f g*,landmark.ilike.*a b c d e f g*',
    );
    expect(searchOrFilter(',,,')).toBeNull();
    expect(searchOrFilter('')).toBeNull();
    expect(searchOrFilter('9876543210')).toBeNull();
  });

  it('opens a lone match by itself only for a name/address or a full number', () => {
    expect(opensSingleMatch('Ravi')).toBe(true);
    expect(opensSingleMatch('9876543210')).toBe(true);
    expect(opensSingleMatch('402')).toBe(false);
    expect(opensSingleMatch('4021')).toBe(false);
    expect(opensSingleMatch('')).toBe(false);
  });
});

describe('the skip or pause holding a meal', () => {
  // The customer skipped Wed on WhatsApp (A); later the owner recorded "skip Mon-Fri" (B).
  // refresh_orders leaves Wed's meal_orders.change_id on A, but private.active_hold says B.
  const A = hold({ change_id: 'A', from_date: '2026-11-11', requested_at: '2026-11-06T04:00:00.000000+00:00' });
  const B = hold({ change_id: 'B', from_date: '2026-11-09', to_date: '2026-11-13', requested_at: '2026-11-06T09:30:00.000000+00:00' });

  it('lists every hold covering the meal, the latest requested first (like private.active_hold)', () => {
    expect(coveringHolds([A, B], SUB, '2026-11-11', 'lunch').map((h) => h.change_id)).toEqual(['B', 'A']);
    expect(coveringHolds([B, A], SUB, '2026-11-11', 'lunch').map((h) => h.change_id)).toEqual(['B', 'A']);
    expect(coveringHolds([A, B], SUB, '2026-11-10', 'lunch').map((h) => h.change_id)).toEqual(['B']);
    expect(coveringHolds([A, B], SUB, '2026-11-14', 'lunch')).toEqual([]);
  });

  it('respects the meal, the subscription, open-ended pauses and resumes', () => {
    const dinnerOnly = hold({ change_id: 'D', from_date: '2026-11-11', slot: 'dinner', requested_at: '2026-11-06T10:00:00Z' });
    expect(coveringHolds([dinnerOnly], SUB, '2026-11-11', 'lunch')).toEqual([]);
    expect(coveringHolds([dinnerOnly], SUB, '2026-11-11', 'dinner')).toEqual([dinnerOnly]);
    expect(coveringHolds([dinnerOnly], 'sub-2', '2026-11-11', 'dinner')).toEqual([]);

    const pause = hold({ change_id: 'P', from_date: '2026-11-09', to_date: null, requested_at: '2026-11-06T10:00:00Z', resumed_from: '2026-11-12' });
    expect(coveringHolds([pause], SUB, '2026-11-11', 'lunch')).toEqual([pause]);
    expect(coveringHolds([pause], SUB, '2026-11-12', 'lunch')).toEqual([]);
    expect(coveringHolds([pause], SUB, '2026-12-25', 'lunch')).toEqual([]);
    expect(coveringHolds([{ ...pause, resumed_from: null }], SUB, '2026-12-25', 'lunch')).toEqual([{ ...pause, resumed_from: null }]);
  });

  it('offers Undo for each covering hold, the active one first', () => {
    const cell = { state: 'skipped' as const, frozen: false, changeable: false, holdIds: ['B', 'A'] };
    expect(cellActions(cell, { twoMeals: false, subscriptionPaused: false })).toEqual([
      { kind: 'undo', holdId: 'B' },
      { kind: 'undo', holdId: 'A' },
    ]);
    // Past the cutoff nothing comes back.
    expect(cellActions({ ...cell, frozen: true }, { twoMeals: false, subscriptionPaused: false })).toEqual([]);
    // A paused subscription can also be resumed from a paused meal.
    expect(cellActions({ ...cell, state: 'paused', holdIds: ['P'] }, { twoMeals: false, subscriptionPaused: true })).toEqual([
      { kind: 'undo', holdId: 'P' },
      { kind: 'resume' },
    ]);
  });
});

describe('what a tapped meal offers', () => {
  const opts = { twoMeals: true, subscriptionPaused: false };
  const base = { frozen: false, changeable: true, holdIds: [] as string[] };

  it('skips, skips the day or pauses an open or locked meal', () => {
    const all = [{ kind: 'skip' }, { kind: 'skip_day' }, { kind: 'pause' }];
    expect(cellActions({ ...base, state: 'open' }, opts)).toEqual(all);
    expect(cellActions({ ...base, state: 'locked', frozen: true }, opts)).toEqual(all);
    expect(cellActions({ ...base, state: 'open' }, { ...opts, twoMeals: false })).toEqual([{ kind: 'skip' }, { kind: 'pause' }]);
  });

  it('can still skip a meal out with the rider while the stop is pending (D-121), not after', () => {
    expect(cellActions({ ...base, state: 'on_way', frozen: true }, opts).map((a) => a.kind)).toEqual(['skip', 'skip_day', 'pause']);
    expect(cellActions({ ...base, state: 'on_way', frozen: true, changeable: false }, opts)).toEqual([]);
  });

  it('waives a charged late skip, and offers nothing for delivered, failed, closed or empty meals', () => {
    expect(cellActions({ ...base, state: 'late_charged', changeable: false }, opts)).toEqual([{ kind: 'waive' }]);
    for (const state of ['delivered', 'failed', 'late_waived', 'closed', 'weekly_off', 'none'] as const) {
      expect(cellActions({ ...base, state, changeable: false }, opts)).toEqual([]);
    }
  });
});

describe('"Close tomorrow"', () => {
  // Kitchen A: lunch closes at 21:00 IST the day before, dinner at 15:00 IST on the day.
  const cutoffs = { lunch: '2026-11-06T15:30:00.000Z', dinner: '2026-11-07T09:30:00.000Z' };

  it('previews the whole day while both meals are open', () => {
    expect(quickClosure(cutoffs, new Date('2026-11-06T14:00:00Z'))).toEqual({ slot: '', locked: [] });
  });

  it('picks dinner once lunch is past its cutoff (a whole day would be refused with slot_locked)', () => {
    expect(quickClosure(cutoffs, new Date('2026-11-06T15:30:00Z'))).toEqual({ slot: 'dinner', locked: ['lunch'] });
    expect(quickClosure(cutoffs, new Date('2026-11-06T16:00:00Z'))).toEqual({ slot: 'dinner', locked: ['lunch'] });
  });

  it('offers nothing once both meals are locked', () => {
    expect(quickClosure(cutoffs, new Date('2026-11-07T10:00:00Z'))).toEqual({ slot: null, locked: ['lunch', 'dinner'] });
  });
});
