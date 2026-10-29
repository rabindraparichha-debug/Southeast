import Link from 'next/link';
import { SLOT_LABEL, formatIstShort, formatServiceDate } from '@tiffin/core';
import type { Database } from '@tiffin/db';
import { Badge } from './ui';

type Change = Database['public']['Functions']['change_feed']['Returns'][number];

const TYPE_LABEL: Record<Change['type'], string> = {
  skip: 'Skip', pause: 'Pause', resume: 'Resume', address: 'Address change', cancel: 'Cancel',
};
const CHANNEL_LABEL: Record<Change['channel'], string> = { whatsapp: 'WhatsApp', web: 'Web', vendor: 'By phone', rider: 'Rider' };

export function ChangeFeed({ changes, linkCustomers }: { changes: Change[]; linkCustomers: boolean }) {
  if (changes.length === 0) return <p className="text-sm text-ink-500">No changes since the last count.</p>;
  return (
    <ul className="divide-y divide-ink-100">
      {changes.map((c) => {
        const dates =
          c.type === 'cancel'
            ? `from ${formatServiceDate(c.from_date)}`
            : c.to_date && c.to_date !== c.from_date
              ? `${formatServiceDate(c.from_date)} – ${formatServiceDate(c.to_date)}`
              : c.to_date
                ? formatServiceDate(c.from_date)
                : `from ${formatServiceDate(c.from_date)}`;
        return (
          <li key={c.change_id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
            <div>
              {linkCustomers ? (
                <Link href={`/customers/${c.customer_id}`} className="font-medium hover:text-brand-700">{c.customer_name}</Link>
              ) : (
                <span className="font-medium">{c.customer_name}</span>
              )}
              <span className="text-ink-600"> · {TYPE_LABEL[c.type]} {dates}{c.slot ? ` (${SLOT_LABEL[c.slot]})` : ''}</span>
              <div className="text-xs text-ink-500">{CHANNEL_LABEL[c.channel]} · {formatIstShort(c.requested_at)}</div>
            </div>
            {c.after_cutoff && <Badge tone={c.late_waived ? 'gray' : 'amber'}>{c.late_waived ? 'Late, waived' : 'Late, charged'}</Badge>}
          </li>
        );
      })}
    </ul>
  );
}
