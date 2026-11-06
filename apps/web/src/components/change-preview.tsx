'use client';

import { SLOT_LABEL, formatServiceDate } from '@tiffin/core';
import type { ChangeResult, ChangeType } from '@tiffin/db';
import { Alert, Badge } from './ui';

// The preview of a schedule change (request_schedule_change or revoke_schedule_change with
// p_dry_run), shared by the customer page and the phone desk. A skip or pause past the cutoff is
// charged (the count is frozen) unless the owner ticks "Don't charge" (D-116 / D-120).

type Affected = ChangeResult['affected'][number];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const mealName = (a: Pick<Affected, 'date' | 'slot'>) => `${formatServiceDate(a.date)} ${SLOT_LABEL[a.slot]}`;

const isHold = (type: ChangeType | 'revoke') => type === 'skip' || type === 'pause';

function Tag({ a, type }: { a: Affected; type: ChangeType | 'revoke' }) {
  if (type === 'revoke') return <Badge tone="green">Comes back</Badge>;
  if (a.credited) return <Badge tone="gray">Not charged</Badge>;
  if (a.charged) return <Badge tone="amber">Charged</Badge>;
  if (a.late) return <Badge tone="gray">After cutoff</Badge>;
  return isHold(type) ? <Badge tone="green">Free</Badge> : null;
}

/**
 * The meals a change touches, each marked charged / not charged, and the "Don't charge" box when
 * a skip or pause reaches meals past the cutoff. `onWaive` re-runs the preview with the new choice.
 */
export function ChangePreview({ preview, type, waive, onWaive, disabled }: {
  preview: ChangeResult;
  type: ChangeType | 'revoke';
  waive: boolean;
  onWaive?: (waive: boolean) => void;
  disabled?: boolean;
}) {
  const affected = preview.affected;
  const late = affected.filter((a) => a.late);
  const charged = affected.filter((a) => a.charged);
  const credited = affected.filter((a) => a.credited);
  return (
    <div className="space-y-2 text-sm" data-testid="change-preview">
      {affected.length === 0 ? (
        <p>
          {type === 'revoke'
            ? 'No meals come back: they are past the cutoff, or outside the next 7 days (those follow automatically).'
            : 'No generated meals are affected yet (meals beyond the next 7 days follow this change automatically).'}
        </p>
      ) : (
        <>
          <p>{type === 'revoke' ? `${plural(affected.length, 'meal')} come${affected.length === 1 ? 's' : ''} back:` : `Affects ${plural(affected.length, 'meal')}:`}</p>
          <ul className="flex flex-wrap gap-1.5">
            {affected.slice(0, 14).map((a) => (
              <li key={`${a.date}-${a.slot}`} className="inline-flex items-center gap-1.5 rounded-lg bg-white px-2 py-1 text-xs ring-1 ring-ink-200">
                {mealName(a)} <Tag a={a} type={type} />
              </li>
            ))}
            {affected.length > 14 && <li className="px-1 py-1 text-xs text-ink-500">and {affected.length - 14} more</li>}
          </ul>
        </>
      )}
      {isHold(type) && charged.length > 0 && (
        <Alert tone="amber">
          {plural(charged.length, 'meal')} {charged.length === 1 ? 'is' : 'are'} past the cutoff: the count is frozen, so {charged.length === 1 ? 'it is' : 'they are'} still charged.
          Tell the customer, or tick “Don’t charge”.
        </Alert>
      )}
      {isHold(type) && late.length > 0 && onWaive && (
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-0.5" checked={waive} disabled={disabled} data-testid="dont-charge"
            onChange={(e) => onWaive(e.target.checked)} />
          <span>
            Don’t charge
            <span className="block text-xs text-ink-500">
              The meal{late.length === 1 ? '' : 's'} past the cutoff {late.length === 1 ? 'is' : 'are'} credited back to the customer; the kitchen bears the cost.
            </span>
          </span>
        </label>
      )}
      {isHold(type) && credited.length > 0 && (
        <p className="text-xs text-ink-600">{plural(credited.length, 'meal')} will be credited back (not charged).</p>
      )}
    </div>
  );
}

/** What to tell the owner after a confirmed change, from the RPC's result. */
export function savedMessage(label: string, type: ChangeType | 'revoke', res: ChangeResult): string {
  const n = res.affected.length;
  if (type === 'revoke') return n ? `${label} saved. ${plural(n, 'meal')} back on: ${res.affected.slice(0, 4).map(mealName).join(', ')}${n > 4 ? '…' : ''}.` : `${label} saved.`;
  if (!isHold(type)) return `${label} saved.`;
  const charged = res.affected.filter((a) => a.charged).length;
  const credited = res.affected.filter((a) => a.credited).length;
  const parts = [`${label} saved.`];
  if (n) parts.push(`${plural(n, 'meal')} ${type === 'pause' ? 'paused' : 'skipped'}.`);
  if (charged) parts.push(`${charged} charged (past the cutoff).`);
  if (credited) parts.push(`${credited} not charged: credited back to the customer.`);
  return parts.join(' ');
}
