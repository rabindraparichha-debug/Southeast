import Link from 'next/link';
import { SLOT_LABEL, formatIstShort, formatServiceDate } from '@tiffin/core';
import type { SlotSummary } from '@tiffin/db';
import { Badge } from './ui';

/** One meal slot: locked or live count, diet split, skips, link to the kitchen sheet. */
export function SlotCard({ s }: { s: SlotSummary }) {
  const totals = s.locked && s.locked_totals ? s.locked_totals : s.live;
  const lateAfterLock = s.locked ? s.live.late_skips - (s.locked_totals?.late_skips ?? 0) : 0;
  return (
    <div className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-ink-100">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-ink-700">
            {formatServiceDate(s.service_date)} · {SLOT_LABEL[s.slot]}
          </div>
          <div className="mt-1 text-xs text-ink-500">
            {s.weekly_off
              ? 'Weekly off'
              : s.locked
                ? `Locked ${formatIstShort(s.locked_at!)}`
                : `Open · closes ${formatIstShort(s.cutoff_at)}`}
          </div>
        </div>
        {s.locked ? <Badge tone="gray">Final</Badge> : <Badge tone="blue">Preview</Badge>}
      </div>
      <div className="mt-3 flex items-baseline gap-2">
        <span className="text-3xl font-semibold text-ink-900">{totals.total_meals}</span>
        <span className="text-sm text-ink-500">meals</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
        <Badge tone="green">Veg {totals.by_diet.veg}</Badge>
        <Badge tone="red">Non-veg {totals.by_diet.nonveg}</Badge>
        <Badge tone="amber">Jain {totals.by_diet.jain}</Badge>
      </div>
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
