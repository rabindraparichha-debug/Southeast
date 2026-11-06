// Pure rules for the phone desk, the customer search and kitchen closures. No React, server or
// network imports, so they are unit-tested from Node (tests/integration/web-desk.test.ts).
import type { MealSlot } from '@tiffin/db';

// ---------------------------------------------------------------------------------------------
// Customer search
// ---------------------------------------------------------------------------------------------

export type QueryKind = 'empty' | 'phone' | 'digits' | 'text';

/** How a search query is read. A full phone number (10+ digits) can only be found by its hash. */
export function queryKind(raw: string): QueryKind {
  const q = raw.trim();
  if (!q) return 'empty';
  const digits = q.replace(/\D/g, '');
  if (digits.length >= 10 && digits === q.replace(/[\s+\-]/g, '')) return 'phone';
  if (/^\d+$/.test(q)) return 'digits';
  return 'text';
}

const SEARCH_CLEAN = /[,()*%"\\:]/g;
const TEXT_COLUMNS = ['name', 'line1', 'area', 'landmark'] as const;

/**
 * The PostgREST `or` filter for a search over customers_v: name, flat (line1), area and landmark.
 * Digits are often a flat number ("402"), so they search the address too; exactly 4 digits also
 * match the last 4 digits of the phone, as search_customers always did. Null: nothing to filter.
 */
export function searchOrFilter(raw: string): string | null {
  const kind = queryKind(raw);
  if (kind === 'empty' || kind === 'phone') return null;
  const term = raw.trim().replace(SEARCH_CLEAN, ' ').replace(/\s+/g, ' ').trim();
  if (!term) return null;
  const parts: string[] = TEXT_COLUMNS.map((c) => `${c}.ilike.*${term}*`);
  if (kind === 'digits' && term.length === 4) parts.push(`phone_last4.eq.${term}`);
  return parts.join(',');
}

/**
 * Whether the phone desk may open a lone result by itself. Bare digits could be a flat or the end
 * of a phone number, so the owner picks from the list (the address and number show there).
 */
export function opensSingleMatch(raw: string): boolean {
  const kind = queryKind(raw);
  return kind === 'phone' || kind === 'text';
}

// ---------------------------------------------------------------------------------------------
// Skips and pauses (subscription_holds)
// ---------------------------------------------------------------------------------------------

export type HoldLike = {
  change_id: string;
  subscription_id?: string;
  from_date: string;
  to_date: string | null;
  slot: MealSlot | null;
  requested_at: string;
  /** The date an open-ended resume ends the hold, if any. */
  resumed_from: string | null;
};

const newestFirst = (a: HoldLike, b: HoldLike) =>
  Date.parse(b.requested_at) - Date.parse(a.requested_at) || b.requested_at.localeCompare(a.requested_at);

/**
 * The skips and pauses that cover one meal, the one holding it first: the latest requested, like
 * private.active_hold, which is the only one revoke_schedule_change brings the meal back for. The
 * meal's own change_id is not used: refresh_orders keeps the first hold there when a later skip or
 * pause covers the same day. The meal comes back only once every hold covering it is undone.
 */
export function coveringHolds<T extends HoldLike>(holds: T[], subscriptionId: string, date: string, slot: MealSlot): T[] {
  return holds
    .filter((h) => h.subscription_id === subscriptionId
      && h.from_date <= date && (!h.to_date || h.to_date >= date)
      && (!h.slot || h.slot === slot)
      && (!h.resumed_from || date < h.resumed_from))
    .sort(newestFirst);
}

// ---------------------------------------------------------------------------------------------
// Phone desk: what a tapped meal offers
// ---------------------------------------------------------------------------------------------

export type CellState =
  | 'open' | 'locked' | 'on_way' | 'delivered' | 'failed'
  | 'skipped' | 'paused' | 'late_charged' | 'late_waived'
  | 'closed' | 'weekly_off' | 'none';

export type DeskActionKind = 'skip' | 'skip_day' | 'pause' | 'resume' | 'waive' | 'undo';

export type CellFacts = {
  state: CellState;
  /** Past its cutoff or locked: a skipped meal can no longer come back. */
  frozen: boolean;
  /** A skip or pause can still reach this meal (out with the rider: only while the stop is pending, D-121). */
  changeable: boolean;
  /** The skips and pauses covering a skipped meal, the one holding it first. */
  holdIds: string[];
};

/** The actions a meal offers on the phone desk, in button order (the first is the main one). */
export function cellActions(cell: CellFacts, opts: { twoMeals: boolean; subscriptionPaused: boolean }): { kind: DeskActionKind; holdId?: string }[] {
  switch (cell.state) {
    case 'open':
    case 'locked':
    case 'on_way':
      if (!cell.changeable) return [];
      return [
        { kind: 'skip' },
        ...(opts.twoMeals ? [{ kind: 'skip_day' as const }] : []),
        { kind: 'pause' },
      ];
    case 'late_charged':
      return [{ kind: 'waive' }];
    case 'skipped':
    case 'paused': {
      if (cell.frozen) return [];
      const out: { kind: DeskActionKind; holdId?: string }[] = cell.holdIds.map((holdId) => ({ kind: 'undo', holdId }));
      if (cell.state === 'paused' && opts.subscriptionPaused) out.push({ kind: 'resume' });
      return out;
    }
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------------------------
// Kitchen closures
// ---------------------------------------------------------------------------------------------

const SLOTS: MealSlot[] = ['lunch', 'dinner'];

/**
 * What "Close tomorrow" previews: the whole day while both meals are before their cutoff, else
 * the meal still open (set_kitchen_closure refuses a whole day once either meal is locked), else
 * nothing (slot null). `locked`: tomorrow's meals already past their cutoff.
 */
export function quickClosure(cutoffs: Record<MealSlot, string>, now: Date): { slot: '' | MealSlot | null; locked: MealSlot[] } {
  const locked = SLOTS.filter((s) => now.getTime() >= Date.parse(cutoffs[s]));
  const open = SLOTS.filter((s) => !locked.includes(s));
  return { slot: open.length === SLOTS.length ? '' : open[0] ?? null, locked };
}
