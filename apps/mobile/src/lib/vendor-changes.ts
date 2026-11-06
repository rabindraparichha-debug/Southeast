// Pure helpers for the owner's change screens on mobile (upcoming holds with Undo, locked meals,
// cancel / reactivate, kitchen closures, the rider's "changed" badge). No React Native imports, so
// tests/integration/mobile-screens.test.ts runs them from Node.
import { SLOT_LABEL, addDays, formatServiceDate } from '@tiffin/core';
import type { ChangeResult, MealSlot, SubscriptionStatus } from '@tiffin/db';
import { t } from '../i18n';

export type Affected = ChangeResult['affected'][number];

/** One row of subscription_holds (the generated type marks every column non-null; they are not). */
export type Hold = {
  change_id: string;
  type: 'skip' | 'pause' | string;
  from_date: string;
  to_date: string | null;
  slot: MealSlot | null;
  after_cutoff: boolean | null;
  resumed_from: string | null;
};

/** "Tue, 10 Nov – Thu, 12 Nov" (one date when both ends are the same day). */
export function dateRange(from: string, to: string): string {
  return to === from ? formatServiceDate(from) : `${formatServiceDate(from)} – ${formatServiceDate(to)}`;
}

/** Last day a hold keeps meals away: its end date, or the day before an open pause was resumed. */
export function holdEnd(h: Pick<Hold, 'to_date' | 'resumed_from'>): string | null {
  return h.resumed_from ? addDays(h.resumed_from, -1) : h.to_date;
}

/** Chip text for an upcoming skip or pause: "Pause Tue, 10 Nov – Thu, 12 Nov · Lunch (late)". */
export function holdLabel(h: Hold): string {
  const end = holdEnd(h);
  const text = !end
    ? t('holds.pauseOpen', { date: formatServiceDate(h.from_date) })
    : t(h.type === 'skip' ? 'holds.skip' : 'holds.pause', { dates: dateRange(h.from_date, end) });
  return `${text}${h.slot ? ` · ${SLOT_LABEL[h.slot]}` : ''}${h.after_cutoff ? ` (${t('holds.late')})` : ''}`;
}

/** "Tue, 10 Nov Lunch, Wed, 11 Nov Lunch…" for a preview (at most `max` meals listed). */
export function mealList(affected: readonly Pick<Affected, 'date' | 'slot'>[], max = 4): string {
  const shown = affected.slice(0, max).map((a) => `${formatServiceDate(a.date)} ${SLOT_LABEL[a.slot]}`).join(', ');
  return affected.length > max ? `${shown}…` : shown;
}

/** How many preview rows are charged to the customer and how many get a "don't charge" credit. */
export function previewCounts(affected: readonly Affected[]): { total: number; charged: number; credited: number } {
  return {
    total: affected.length,
    charged: affected.filter((a) => a.charged).length,
    credited: affected.filter((a) => a.credited).length,
  };
}

export type MealRow = {
  id: string;
  subscription_id: string;
  service_date: string;
  slot: MealSlot;
  qty: number;
  status: string;
  charged: boolean;
  charge_waived?: boolean | null;
  locked_at: string | null;
};

/**
 * skip: a frozen meal still on its way (skipping it now is charged unless "don't charge");
 * waive: a meal already skipped late and still charged ("don't charge" gives it back).
 */
export type LockedAction = 'skip' | 'waive';
export type LockedChip = { meal: MealRow; action: LockedAction };

const ON_ITS_WAY = new Set(['locked', 'prepared', 'out']);

/** Today's and tomorrow's meals whose count is frozen, as chips (earliest first). */
export function lockedMealChips(meals: readonly MealRow[], today: string): LockedChip[] {
  const tomorrow = addDays(today, 1);
  const chips: LockedChip[] = [];
  for (const m of meals) {
    if (!m.locked_at || (m.service_date !== today && m.service_date !== tomorrow)) continue;
    if (ON_ITS_WAY.has(m.status)) chips.push({ meal: m, action: 'skip' });
    else if (m.status === 'skipped' && m.charged && !m.charge_waived) chips.push({ meal: m, action: 'waive' });
  }
  return chips.sort((a, b) =>
    a.meal.service_date.localeCompare(b.meal.service_date) || (a.meal.slot === b.meal.slot ? 0 : a.meal.slot === 'lunch' ? -1 : 1));
}

/** "Don't charge" is always on for a waive chip; for a skip it is the owner's choice. */
export function waiveFor(action: LockedAction, dontCharge: boolean): boolean {
  return action === 'waive' || dontCharge;
}

/** First day without meals when cancelling: the kitchen's notice period from today. */
export function cancelFromDefault(today: string, noticeDays: number | null | undefined): string {
  const n = Number.isFinite(noticeDays) ? Math.max(0, Math.floor(noticeDays as number)) : 1;
  return addDays(today, n);
}

/** Keeps a date inside [min, max] (YYYY-MM-DD strings compare in date order). */
export function clampDate(date: string, min: string, max?: string): string {
  if (date < min) return min;
  if (max && date > max) return max;
  return date;
}

type SubLike = { id: string; status: SubscriptionStatus | string; created_at: string };

/** Live subscriptions first (newest first), then the latest few cancelled ones. */
export function sortSubscriptions<T extends SubLike>(subs: readonly T[], maxCancelled = 3): T[] {
  const newest = (a: T, b: T) => b.created_at.localeCompare(a.created_at);
  const live = subs.filter((s) => s.status !== 'cancelled').sort(newest);
  const cancelled = subs.filter((s) => s.status === 'cancelled').sort(newest).slice(0, maxCancelled);
  return [...live, ...cancelled];
}

/** Which actions a subscription offers on mobile (owner): cancel while live, reactivate once cancelled. */
export function subscriptionActions(status: SubscriptionStatus | string): { cancel: boolean; reactivate: boolean; holds: boolean } {
  return {
    cancel: status !== 'cancelled' && status !== 'trial',
    reactivate: status === 'cancelled',
    holds: status !== 'cancelled',
  };
}

/** True when reactivating left the subscription waiting for money (empty prepaid balance). */
export function reactivatedWithoutBalance(status: SubscriptionStatus | string): boolean {
  return status === 'low_balance' || status === 'suspended';
}

/** "Tue, 10 Nov · Whole day · Diwali" */
export function closureLabel(c: { closed_on: string; slot: MealSlot | null; reason?: string | null }): string {
  return [formatServiceDate(c.closed_on), c.slot ? SLOT_LABEL[c.slot] : t('closure.whole'), c.reason?.trim()]
    .filter(Boolean).join(' · ');
}

/** The rider's "changed" badge: only on stops still to deliver that the kitchen changed after the list was made. */
export function showChanged(stop: { status: string; changed?: boolean | null }): boolean {
  return stop.status === 'pending' && stop.changed === true;
}
