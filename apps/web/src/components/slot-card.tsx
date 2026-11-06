import Link from 'next/link';
import { SLOT_LABEL, formatIstShort, formatServiceDate } from '@tiffin/core';
import type { SlotSummary } from '@tiffin/db';
import { Badge } from './ui';
import { FreezeButton } from './freeze-button';
import { healthLabel, type SlotTotalsP5 } from '@/lib/p5';

/** Minutes after the cutoff before an unlocked slot counts as "not frozen" (the lock job runs every minute). */
export const FREEZE_GRACE_MS = 5 * 60_000;

/**
 * True when the cutoff passed (plus grace) with meals ordered but no count snapshot: the engine missed it.
 * Uses slot_summary's own `overdue` (server clock) when present; closed slots are never overdue.
 */
export function isCountOverdue(s: SlotSummary, now = Date.now()): boolean {
  if (s.locked || s.closed || s.live.orders <= 0) return false;
  return s.overdue ?? now > Date.parse(s.cutoff_at) + FREEZE_GRACE_MS;
}

/** One meal slot: locked or live count, diet split, skips, link to the kitchen sheet. */
export function SlotCard({ s, kitchenId, canFreeze = false }: { s: SlotSummary; kitchenId?: string; canFreeze?: boolean }) {
  const totals: SlotTotalsP5 = s.locked && s.locked_totals ? s.locked_totals : s.live;
  const health = Object.entries(totals.by_health ?? {});
  const lateAfterLock = s.locked ? s.live.late_skips - (s.locked_totals?.late_skips ?? 0) : 0;
  const overdue = isCountOverdue(s);
  return (
    <div className={`rounded-xl bg-white p-4 shadow-sm ring-1 ${overdue ? 'ring-2 ring-red-300' : 'ring-ink-100'}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-ink-700">
            {formatServiceDate(s.service_date)} · {SLOT_LABEL[s.slot]}
          </div>
          <div className="mt-1 text-xs text-ink-500">
            {s.closed
              ? `Kitchen closed${s.closure_reason ? ` · ${s.closure_reason}` : ''}`
              : s.weekly_off
              ? 'Weekly off'
              : s.locked
                ? `Locked ${formatIstShort(s.locked_at!)}`
                : overdue
                  ? `Closed ${formatIstShort(s.cutoff_at)} · not locked`
                  : `Open · closes ${formatIstShort(s.cutoff_at)}`}
          </div>
        </div>
        {s.locked ? <Badge tone="gray">Final</Badge> : overdue ? <Badge tone="red">Not frozen</Badge> : <Badge tone="blue">Preview</Badge>}
      </div>
      {overdue && (
        <div role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800 ring-1 ring-red-200">
          <strong>Count not frozen.</strong> Changes closed at {formatIstShort(s.cutoff_at)}, but the automatic lock has not run, so
          this count is not final and the meals are not charged or routed yet.
          {s.engine_error && <span className="mt-1 block text-xs text-red-700">Engine error: {s.engine_error}</span>}
          {canFreeze && kitchenId ? (
            <FreezeButton kitchenId={kitchenId} date={s.service_date} slot={s.slot} />
          ) : (
            <span> Ask the owner to press Freeze now.</span>
          )}
        </div>
      )}
      <div className="mt-3 flex items-baseline gap-2">
        <span className="text-3xl font-semibold text-ink-900">{totals.total_meals}</span>
        <span className="text-sm text-ink-500">meals</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
        <Badge tone="green">Veg {totals.by_diet.veg}</Badge>
        <Badge tone="red">Non-veg {totals.by_diet.nonveg}</Badge>
        <Badge tone="amber">Jain {totals.by_diet.jain}</Badge>
      </div>
      {((totals.veg_switched ?? 0) > 0 || health.length > 0) && (
        <div className="mt-1.5 text-xs text-ink-600">
          {(totals.veg_switched ?? 0) > 0 && <span className="text-green-800">{totals.veg_switched} switched to veg (veg day)</span>}
          {(totals.veg_switched ?? 0) > 0 && health.length > 0 && ' · '}
          {health.map(([t, n]) => `${healthLabel(t)} ${n}`).join(' · ')}
        </div>
      )}
      <div className="mt-2 text-xs text-ink-500">
        {s.live.skipped} skipped
        {s.live.late_skips > 0 && ` · ${s.live.late_skips} late skip${s.live.late_skips > 1 ? 's' : ''} (charged, don’t deliver)`}
        {lateAfterLock > 0 && ` · ${lateAfterLock} after lock`}
      </div>
      {totals.orders > 0 && (
        <Link href={`/sheet?date=${s.service_date}&slot=${s.slot}`} className="mt-3 inline-block text-sm font-medium text-brand-700 hover:underline">
          Kitchen sheet →
        </Link>
      )}
    </div>
  );
}
