// Unit tests for the mobile vendor screens' pure logic (no network, no React Native):
// - screen-cache.ts: the offline copies of Today, the customer list and the packing list (who may
//   read a copy, no phone numbers for staff, freshness, pruning, offline search);
// - vendor-changes.ts: chip state and labels for upcoming holds (Undo), locked meals ("don't
//   charge"), cancel / reactivate, kitchen closures and the rider's "changed" badge.
import { describe, expect, it } from 'vitest';
import { SLOT_LABEL, formatServiceDate } from '@tiffin/core';
import {
  CACHE_MAX_AGE_MS, CACHE_PREFIX, cacheKey, filterCachedCustomers, isOfflineError, makeEntry, oldSheetKeys, readEntry,
  stripPhones, toErrorLike, type CacheScope,
} from '../../apps/mobile/src/lib/screen-cache.ts';
import {
  cancelFromDefault, clampDate, closureLabel, dateRange, holdEnd, holdLabel, lockedMealChips, mealList, previewCounts,
  reactivatedWithoutBalance, showChanged, sortSubscriptions, subscriptionActions, waiveFor, type Hold, type MealRow,
} from '../../apps/mobile/src/lib/vendor-changes.ts';

const owner: CacheScope = { userId: 'u-owner', kitchenId: 'k-1', role: 'owner' };
const staff: CacheScope = { userId: 'u-staff', kitchenId: 'k-1', role: 'staff' };
const now = new Date('2026-11-06T10:00:00.000Z');

const customer = {
  id: 'c-1', name: 'Sujata Das', line1: 'Flat 4B', area: 'Patia', landmark: 'Near KIIT', phone: '+919861000001', phone_last4: '0001',
};

describe('screen copies: keys and phone numbers', () => {
  it('keys a copy by kitchen, screen and part', () => {
    expect(cacheKey(owner, 'today')).toBe(`${CACHE_PREFIX}k-1:today`);
    expect(cacheKey(owner, 'sheet', '2026-11-06.lunch')).toBe(`${CACHE_PREFIX}k-1:sheet:2026-11-06.lunch`);
  });

  it('strips every phone field at any depth', () => {
    const data = { rows: [customer, { ...customer, id: 'c-2', payer: { name: 'Papa', payer_phone: '+919861000002' } }], total: 2 };
    const out = stripPhones(data);
    expect(JSON.stringify(out)).not.toMatch(/9861/);
    expect(out.rows[0]).toEqual({ id: 'c-1', name: 'Sujata Das', line1: 'Flat 4B', area: 'Patia', landmark: 'Near KIIT' });
    expect(out.total).toBe(2);
    expect(stripPhones(null)).toBeNull();
    expect(stripPhones('text')).toBe('text');
  });

  it('never saves phone numbers for staff; the owner keeps them', () => {
    const forStaff = makeEntry(staff, [customer], now);
    expect(JSON.stringify(forStaff)).not.toMatch(/9861|0001/);
    expect(forStaff).toMatchObject({ v: 1, userId: 'u-staff', kitchenId: 'k-1', role: 'staff', savedAt: now.toISOString() });
    const forOwner = makeEntry(owner, [customer], now);
    expect(forOwner.data[0]?.phone).toBe('+919861000001');
  });
});

describe('screen copies: reading back', () => {
  const raw = JSON.stringify(makeEntry(owner, { slots: [1, 2] }, now));

  it('reads the copy saved by the same user, kitchen and role', () => {
    expect(readEntry<{ slots: number[] }>(raw, owner, now)?.data.slots).toEqual([1, 2]);
  });

  it('ignores copies of another user, kitchen or role', () => {
    expect(readEntry(raw, { ...owner, userId: 'someone-else' }, now)).toBeNull();
    expect(readEntry(raw, { ...owner, kitchenId: 'k-2' }, now)).toBeNull();
    expect(readEntry(raw, { ...owner, role: 'staff' }, now)).toBeNull();
  });

  it('ignores damaged, unknown-version or too-old copies', () => {
    expect(readEntry(null, owner, now)).toBeNull();
    expect(readEntry('', owner, now)).toBeNull();
    expect(readEntry('{not json', owner, now)).toBeNull();
    expect(readEntry('"text"', owner, now)).toBeNull();
    expect(readEntry(JSON.stringify({ ...JSON.parse(raw), v: 2 }), owner, now)).toBeNull();
    expect(readEntry(JSON.stringify({ ...JSON.parse(raw), savedAt: 'yesterday-ish' }), owner, now)).toBeNull();
    const later = new Date(now.getTime() + CACHE_MAX_AGE_MS + 1);
    expect(readEntry(raw, owner, later)).toBeNull();
    expect(readEntry(raw, owner, new Date(now.getTime() + CACHE_MAX_AGE_MS - 1))).not.toBeNull();
  });

  it('strips phone numbers again when anyone but the owner reads a copy', () => {
    // A copy that somehow holds a number (e.g. written by an older version) is cleaned on read.
    const bad = JSON.stringify({ v: 1, userId: 'u-staff', kitchenId: 'k-1', role: 'staff', savedAt: now.toISOString(), data: [customer] });
    expect(JSON.stringify(readEntry(bad, staff, now))).not.toMatch(/9861|0001/);
  });
});

describe('screen copies: offline detection', () => {
  it('treats "no answer from the server" as offline, like the rider queue', () => {
    expect(isOfflineError({ message: 'TypeError: Network request failed' })).toBe(true);
    expect(isOfflineError({ message: 'AbortError: Aborted', name: 'AbortError' })).toBe(true);
    expect(isOfflineError(toErrorLike(new TypeError('Network request failed')))).toBe(true);
  });

  it('a server answer is not offline (the screen says "could not load")', () => {
    expect(isOfflineError({ message: 'forbidden', code: '42501' })).toBe(false);
    expect(isOfflineError({ message: 'upstream', status: 503 })).toBe(false);
    expect(isOfflineError(null)).toBe(false);
  });

  it('turns thrown values into errors', () => {
    expect(toErrorLike(new Error('boom'))).toMatchObject({ message: 'boom', name: 'Error' });
    expect(toErrorLike('weird')).toEqual({ message: 'weird' });
    expect(toErrorLike(undefined)).toEqual({ message: 'network' });
  });
});

describe('screen copies: packing list pruning and offline search', () => {
  it('drops this kitchen’s packing lists before the keep date only', () => {
    const keys = [
      `${CACHE_PREFIX}k-1:sheet:2026-11-02.lunch`,
      `${CACHE_PREFIX}k-1:sheet:2026-11-03.dinner`,
      `${CACHE_PREFIX}k-1:sheet:2026-11-04.lunch`,
      `${CACHE_PREFIX}k-1:sheet:2026-11-06.dinner`,
      `${CACHE_PREFIX}k-1:sheet:garbage`,
      `${CACHE_PREFIX}k-2:sheet:2026-11-01.lunch`,
      `${CACHE_PREFIX}k-1:today`,
      'tiffin.rider.queue',
    ];
    expect(oldSheetKeys(keys, 'k-1', '2026-11-04')).toEqual([
      `${CACHE_PREFIX}k-1:sheet:2026-11-02.lunch`,
      `${CACHE_PREFIX}k-1:sheet:2026-11-03.dinner`,
      `${CACHE_PREFIX}k-1:sheet:garbage`,
    ]);
  });

  it('searches the saved list by name, flat, area, landmark and (owner copy) number', () => {
    const rows = [
      customer,
      { id: 'c-2', name: 'Ravi Kumar', line1: null, area: 'Saheed Nagar', landmark: 'Big Bazaar', phone: null, phone_last4: null },
    ];
    expect(filterCachedCustomers(rows, '').map((r) => r.id)).toEqual(['c-1', 'c-2']);
    expect(filterCachedCustomers(rows, 'sujata').map((r) => r.id)).toEqual(['c-1']);
    expect(filterCachedCustomers(rows, 'saheed bazaar').map((r) => r.id)).toEqual(['c-2']);
    expect(filterCachedCustomers(rows, 'kiit').map((r) => r.id)).toEqual(['c-1']);
    expect(filterCachedCustomers(rows, '98610').map((r) => r.id)).toEqual(['c-1']);
    expect(filterCachedCustomers(rows, 'nobody')).toEqual([]);
    // A staff copy has no numbers, so digits find nobody.
    expect(filterCachedCustomers(stripPhones(rows), '98610')).toEqual([]);
  });
});

describe('upcoming holds (Undo chips)', () => {
  const base: Hold = { change_id: 'h-1', type: 'skip', from_date: '2026-11-10', to_date: '2026-11-10', slot: null, after_cutoff: false, resumed_from: null };

  it('labels a one-day skip, a skip range and a meal', () => {
    expect(holdLabel(base)).toBe(`Skip ${formatServiceDate('2026-11-10')}`);
    expect(holdLabel({ ...base, to_date: '2026-11-12', slot: 'lunch' }))
      .toBe(`Skip ${formatServiceDate('2026-11-10')} – ${formatServiceDate('2026-11-12')} · ${SLOT_LABEL.lunch}`);
  });

  it('labels pauses: dated, open-ended, ended by a resume, and late ones', () => {
    const pause = { ...base, type: 'pause', to_date: '2026-11-20' };
    expect(holdLabel(pause)).toBe(`Pause ${dateRange('2026-11-10', '2026-11-20')}`);
    expect(holdLabel({ ...pause, to_date: null })).toBe(`Pause from ${formatServiceDate('2026-11-10')} (until resumed)`);
    expect(holdEnd({ to_date: null, resumed_from: '2026-11-15' })).toBe('2026-11-14');
    expect(holdLabel({ ...pause, to_date: null, resumed_from: '2026-11-15' })).toBe(`Pause ${dateRange('2026-11-10', '2026-11-14')}`);
    expect(holdLabel({ ...base, after_cutoff: true })).toBe(`Skip ${formatServiceDate('2026-11-10')} (late)`);
  });

  it('only live subscriptions list holds and can cancel; only cancelled ones reactivate', () => {
    expect(subscriptionActions('active')).toEqual({ cancel: true, reactivate: false, holds: true });
    expect(subscriptionActions('suspended')).toEqual({ cancel: true, reactivate: false, holds: true });
    expect(subscriptionActions('trial')).toEqual({ cancel: false, reactivate: false, holds: true });
    expect(subscriptionActions('cancelled')).toEqual({ cancel: false, reactivate: true, holds: false });
    expect(reactivatedWithoutBalance('suspended')).toBe(true);
    expect(reactivatedWithoutBalance('low_balance')).toBe(true);
    expect(reactivatedWithoutBalance('active')).toBe(false);
  });

  it('lists live subscriptions first, then the latest three cancelled', () => {
    const subs = [
      { id: 'c1', status: 'cancelled', created_at: '2026-01-01' },
      { id: 'a1', status: 'active', created_at: '2026-02-01' },
      { id: 'c2', status: 'cancelled', created_at: '2026-03-01' },
      { id: 'c3', status: 'cancelled', created_at: '2026-04-01' },
      { id: 'p1', status: 'paused', created_at: '2026-05-01' },
      { id: 'c4', status: 'cancelled', created_at: '2026-06-01' },
    ];
    expect(sortSubscriptions(subs).map((s) => s.id)).toEqual(['p1', 'a1', 'c4', 'c3', 'c2']);
  });
});

describe('previews', () => {
  const affected = [
    { date: '2026-11-07', slot: 'lunch' as const, late: true, charged: true, credited: false },
    { date: '2026-11-07', slot: 'dinner' as const, late: true, charged: false, credited: true },
    { date: '2026-11-08', slot: 'lunch' as const, late: false, charged: false, credited: false },
  ];

  it('counts charged and credited meals', () => {
    expect(previewCounts(affected)).toEqual({ total: 3, charged: 1, credited: 1 });
    expect(previewCounts([])).toEqual({ total: 0, charged: 0, credited: 0 });
  });

  it('lists at most a few meals', () => {
    expect(mealList(affected, 2)).toBe(`${formatServiceDate('2026-11-07')} Lunch, ${formatServiceDate('2026-11-07')} Dinner…`);
    expect(mealList(affected.slice(0, 1))).toBe(`${formatServiceDate('2026-11-07')} Lunch`);
  });
});

describe('locked meals (skip after the lock, "don’t charge")', () => {
  const today = '2026-11-06';
  const meal = (over: Partial<MealRow>): MealRow => ({
    id: 'm', subscription_id: 's-1', service_date: today, slot: 'lunch', qty: 1, status: 'locked', charged: false,
    charge_waived: false, locked_at: '2026-11-05T15:30:00Z', ...over,
  });

  it('offers a skip for frozen meals still on their way, today and tomorrow only', () => {
    const chips = lockedMealChips([
      meal({ id: 'tomorrow-dinner', service_date: '2026-11-07', slot: 'dinner' }),
      meal({ id: 'today-dinner', slot: 'dinner', status: 'prepared' }),
      meal({ id: 'today-lunch', status: 'out' }),
      meal({ id: 'tomorrow-lunch', service_date: '2026-11-07' }),
      meal({ id: 'later', service_date: '2026-11-08' }),
      meal({ id: 'open', locked_at: null, status: 'scheduled' }),
      meal({ id: 'delivered', status: 'delivered' }),
      meal({ id: 'failed', status: 'failed' }),
    ], today);
    expect(chips.map((c) => `${c.meal.id}:${c.action}`)).toEqual([
      'today-lunch:skip', 'today-dinner:skip', 'tomorrow-lunch:skip', 'tomorrow-dinner:skip',
    ]);
  });

  it('offers "don’t charge" for a late skip still charged, never twice', () => {
    const chips = lockedMealChips([
      meal({ id: 'late-charged', status: 'skipped', charged: true }),
      meal({ id: 'late-waived', status: 'skipped', charged: true, charge_waived: true }),
      meal({ id: 'free-skip', status: 'skipped', charged: false }),
    ], today);
    expect(chips.map((c) => `${c.meal.id}:${c.action}`)).toEqual(['late-charged:waive']);
  });

  it('a waive chip always sends "don’t charge"; a skip only when ticked', () => {
    expect(waiveFor('waive', false)).toBe(true);
    expect(waiveFor('skip', false)).toBe(false);
    expect(waiveFor('skip', true)).toBe(true);
  });
});

describe('dates, closures and the rider badge', () => {
  it('cancels from the notice period, never before today', () => {
    expect(cancelFromDefault('2026-11-06', 1)).toBe('2026-11-07');
    expect(cancelFromDefault('2026-11-06', 0)).toBe('2026-11-06');
    expect(cancelFromDefault('2026-11-06', -3)).toBe('2026-11-06');
    expect(cancelFromDefault('2026-11-06', null)).toBe('2026-11-07');
    expect(cancelFromDefault('2026-11-30', 2)).toBe('2026-12-02');
  });

  it('keeps a date within bounds', () => {
    expect(clampDate('2026-11-01', '2026-11-06', '2026-12-01')).toBe('2026-11-06');
    expect(clampDate('2026-12-05', '2026-11-06', '2026-12-01')).toBe('2026-12-01');
    expect(clampDate('2026-11-10', '2026-11-06')).toBe('2026-11-10');
  });

  it('labels a closure', () => {
    expect(closureLabel({ closed_on: '2026-11-08', slot: null, reason: 'Diwali' })).toBe(`${formatServiceDate('2026-11-08')} · Whole day · Diwali`);
    expect(closureLabel({ closed_on: '2026-11-08', slot: 'dinner', reason: '  ' })).toBe(`${formatServiceDate('2026-11-08')} · Dinner`);
  });

  it('shows "changed" only on stops still to deliver', () => {
    expect(showChanged({ status: 'pending', changed: true })).toBe(true);
    expect(showChanged({ status: 'delivered', changed: true })).toBe(false);
    expect(showChanged({ status: 'pending', changed: false })).toBe(false);
    expect(showChanged({ status: 'pending' })).toBe(false); // caches saved by older versions
  });
});
