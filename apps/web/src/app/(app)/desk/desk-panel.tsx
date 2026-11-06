'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { SLOT_LABEL, addDays, formatServiceDate } from '@tiffin/core';
import type { ChangeResult, ChangeType, MealSlot, SubscriptionStatus } from '@tiffin/db';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Alert, Badge, Button, Card, Field, Input, STATUS_LABEL, STATUS_TONE } from '@/components/ui';
import { ChangePreview, savedMessage } from '@/components/change-preview';
import { HoldsList, holdDates, type Hold } from '@/components/holds-list';

export type CellState =
  | 'open' | 'locked' | 'on_way' | 'delivered' | 'failed'
  | 'skipped' | 'paused' | 'late_charged' | 'late_waived'
  | 'closed' | 'weekly_off' | 'none';

export type DeskCell = {
  slot: MealSlot;
  state: CellState;
  orderId?: string;
  qty: number;
  /** The skip or pause behind a skipped meal (Undo). */
  holdId: string | null;
  /** Past its cutoff or locked: a skipped meal can no longer come back. */
  frozen: boolean;
  /** Open meals: when changes close (IST). */
  until: string | null;
};

export type DeskSub = {
  id: string;
  planName: string;
  status: SubscriptionStatus;
  qty: number;
  slots: MealSlot[];
  days: { date: string; cells: DeskCell[] }[];
};

const CELL: Record<CellState, { label: string; tone: string }> = {
  open: { label: 'Coming', tone: 'bg-green-50 ring-green-200 text-green-900' },
  locked: { label: 'Locked', tone: 'bg-white ring-ink-200 text-ink-800' },
  on_way: { label: 'On the way', tone: 'bg-blue-50 ring-blue-200 text-blue-900' },
  delivered: { label: 'Delivered', tone: 'bg-white ring-ink-100 text-ink-500' },
  failed: { label: 'Not delivered', tone: 'bg-red-50 ring-red-200 text-red-800' },
  skipped: { label: 'Skipped', tone: 'bg-ink-50 ring-ink-200 text-ink-500' },
  paused: { label: 'Paused', tone: 'bg-ink-50 ring-ink-200 text-ink-500' },
  late_charged: { label: 'Skipped · charged', tone: 'bg-amber-50 ring-amber-200 text-amber-900' },
  late_waived: { label: 'Skipped · not charged', tone: 'bg-ink-50 ring-ink-200 text-ink-500' },
  closed: { label: 'Kitchen closed', tone: 'bg-ink-50 ring-ink-100 text-ink-400' },
  weekly_off: { label: 'Day off', tone: 'bg-ink-50 ring-ink-100 text-ink-400' },
  none: { label: 'No meal', tone: 'bg-white ring-ink-100 text-ink-400' },
};

type ActionKind = 'skip' | 'skip_day' | 'pause' | 'resume' | 'waive' | 'undo';
type Action = { kind: ActionKind; subId: string; from: string; slot: MealSlot | null; holdId?: string; label: string };

const changeType = (k: ActionKind): ChangeType | 'revoke' =>
  k === 'undo' ? 'revoke' : k === 'skip_day' || k === 'waive' ? 'skip' : k;

export function DeskPanel({ customer, subs, holds, today, cancelled }: {
  customer: { id: string; name: string; phone: string; address: string; notes: string | null };
  subs: DeskSub[];
  holds: Hold[];
  today: string;
  cancelled: number;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<{ subId: string; date: string; slot: MealSlot } | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [pauseTo, setPauseTo] = useState('');
  const [waive, setWaive] = useState(false);
  const [preview, setPreview] = useState<ChangeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  // On a phone the action box sits under the week: bring it into view when a meal or action is picked.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [selected, action]);

  async function run(a: Action, dryRun: boolean, opts: { waive?: boolean; to?: string } = {}) {
    const w = opts.waive ?? waive;
    const to = opts.to ?? pauseTo;
    setBusy(true);
    setError('');
    const supabase = supabaseBrowser();
    const { data, error } = a.kind === 'undo'
      ? await supabase.rpc('revoke_schedule_change', { p_change: a.holdId!, p_dry_run: dryRun })
      : await supabase.rpc('request_schedule_change', {
          p_subscription: a.subId,
          p_type: changeType(a.kind) as ChangeType,
          p_from: a.from,
          p_to: a.kind === 'pause' ? to || undefined : a.kind === 'resume' ? undefined : a.from,
          p_slot: a.slot ?? undefined,
          p_waive_late: a.kind === 'waive' ? true : a.kind === 'skip' || a.kind === 'skip_day' || a.kind === 'pause' ? w : false,
          p_dry_run: dryRun,
        });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    const res = data as unknown as ChangeResult;
    if (dryRun) return setPreview(res);
    setDone(savedMessage(a.label, changeType(a.kind), res));
    setAction(null);
    setPreview(null);
    setSelected(null);
    router.refresh();
  }

  /** Pick an action: the preview runs by itself (as on mobile), then one Confirm. */
  function choose(a: Action) {
    setAction(a);
    setPreview(null);
    setDone('');
    setWaive(a.kind === 'waive');
    setPauseTo('');
    void run(a, true, { waive: a.kind === 'waive', to: '' });
  }

  function pick(subId: string, date: string, slot: MealSlot) {
    const same = selected?.subId === subId && selected.date === date && selected.slot === slot;
    setSelected(same ? null : { subId, date, slot });
    setAction(null);
    setPreview(null);
    setError('');
  }

  const tomorrow = addDays(today, 1);

  return (
    <div className="space-y-4" data-testid="desk-panel">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-ink-900">{customer.name}</h2>
            <p className="text-sm text-ink-600">{customer.phone}</p>
            <p className="text-sm text-ink-600">{customer.address || 'No address yet'}</p>
            {customer.notes && <p className="text-xs text-amber-800">Note: {customer.notes}</p>}
          </div>
          <Link href={`/customers/${customer.id}`} className="text-sm font-medium text-brand-700 hover:underline">
            Full customer page (payments, address, plan) →
          </Link>
        </div>
        {done && <div className="mt-3"><Alert tone="green">{done}</Alert></div>}
      </Card>

      {subs.length === 0 && (
        <Card>
          <p className="text-sm text-ink-600">
            No live subscription.{cancelled > 0 ? ' A cancelled one can be reactivated on the customer page.' : ' Add one on the customer page.'}
          </p>
        </Card>
      )}

      {subs.map((s) => {
        const sel = selected?.subId === s.id ? selected : null;
        const cell = sel ? s.days.find((d) => d.date === sel.date)?.cells.find((c) => c.slot === sel.slot) : undefined;
        const two = s.slots.length > 1;
        return (
          <Card
            key={s.id}
            title={<span className="flex flex-wrap items-center gap-2">{s.planName}{s.qty > 1 && <span className="text-sm font-normal text-ink-500">× {s.qty}</span>}<Badge tone={STATUS_TONE[s.status]}>{STATUS_LABEL[s.status]}</Badge></span>}
            actions={
              <div className="flex flex-wrap gap-1.5">
                <Button variant="secondary" className="px-3 py-1" disabled={busy}
                  onClick={() => { setSelected(null); choose({ kind: 'skip_day', subId: s.id, from: tomorrow, slot: null, label: 'Skip tomorrow' }); }}
                  data-testid="desk-skip-tomorrow">
                  Skip tomorrow
                </Button>
                {s.status === 'paused' ? (
                  <Button variant="secondary" className="px-3 py-1" disabled={busy}
                    onClick={() => { setSelected(null); choose({ kind: 'resume', subId: s.id, from: today, slot: null, label: 'Resume' }); }}
                    data-testid="desk-resume">
                    Resume
                  </Button>
                ) : (
                  <Button variant="secondary" className="px-3 py-1" disabled={busy}
                    onClick={() => { setSelected(null); choose({ kind: 'pause', subId: s.id, from: tomorrow, slot: null, label: 'Pause' }); }}
                    data-testid="desk-pause">
                    Pause from tomorrow
                  </Button>
                )}
              </div>
            }
          >
            <div className={`grid gap-1.5 text-xs ${two ? 'grid-cols-[4.5rem_1fr_1fr]' : 'grid-cols-[4.5rem_1fr]'}`} data-testid="desk-week">
              <div />
              {s.slots.map((sl) => <div key={sl} className="px-1 font-medium text-ink-500">{SLOT_LABEL[sl]}</div>)}
              {s.days.map((d) => (
                <DayRow key={d.date} date={d.date} today={today} cells={d.cells} selected={sel}
                  onPick={(slot) => pick(s.id, d.date, slot)} />
              ))}
            </div>

            {sel && cell && !action && (
              <div ref={box} className="mt-3 space-y-2 rounded-lg bg-ink-50 p-3 text-sm ring-1 ring-ink-200" data-testid="desk-actions">
                <p className="font-medium">{formatServiceDate(sel.date)} · {SLOT_LABEL[sel.slot]}: {CELL[cell.state].label}</p>
                <CellActions cell={cell} sub={s} date={sel.date} two={two} holds={holds} today={today} busy={busy} onChoose={choose} />
              </div>
            )}

            {action && action.subId === s.id && (
              <div ref={box} className="mt-3 space-y-3 rounded-lg bg-ink-50 p-3 ring-1 ring-ink-200" data-testid="desk-confirm">
                <p className="text-sm font-medium">
                  {action.label}
                  {action.kind !== 'undo' && action.kind !== 'pause' && action.kind !== 'resume' && `: ${formatServiceDate(action.from)}${action.slot ? ` ${SLOT_LABEL[action.slot]}` : ''}`}
                  {action.kind === 'resume' && ` from ${formatServiceDate(action.from)}`}
                </p>
                {action.kind === 'pause' && (
                  <div className="space-y-1">
                    <p className="text-sm text-ink-700">From {formatServiceDate(action.from)}</p>
                    <Field label="Until (empty: until you resume)" className="max-w-56">
                      <Input type="date" min={action.from} value={pauseTo} data-testid="pause-until"
                        onChange={(e) => { setPauseTo(e.target.value); setPreview(null); void run(action, true, { to: e.target.value }); }} />
                    </Field>
                  </div>
                )}
                {busy && !preview && <p className="text-sm text-ink-500">Checking…</p>}
                {preview && (
                  <ChangePreview preview={preview} type={changeType(action.kind)} waive={waive} disabled={busy}
                    onWaive={action.kind === 'waive' || action.kind === 'undo' ? undefined : (w) => { setWaive(w); void run(action, true, { waive: w }); }} />
                )}
                <div className="flex gap-2">
                  <Button onClick={() => run(action, false)} disabled={busy || !preview} data-testid="desk-confirm-button">
                    {busy && preview ? 'Saving…' : 'Confirm'}
                  </Button>
                  <Button variant="ghost" onClick={() => { setAction(null); setPreview(null); }}>Back</Button>
                </div>
              </div>
            )}
          </Card>
        );
      })}

      <Card title="Upcoming skips and pauses">
        <HoldsList holds={holds} canUndo compact />
      </Card>
      <div><Alert>{error}</Alert></div>
    </div>
  );
}

function DayRow({ date, today, cells, selected, onPick }: {
  date: string; today: string; cells: DeskCell[];
  selected: { date: string; slot: MealSlot } | null; onPick: (slot: MealSlot) => void;
}) {
  const [weekday, day] = formatServiceDate(date).split(', ');
  const label = date === today ? 'Today' : date === addDays(today, 1) ? 'Tomorrow' : weekday;
  return (
    <>
      <div className="flex flex-col justify-center px-1 leading-tight">
        <span className="font-medium text-ink-800">{label}</span>
        <span className="text-ink-500">{day ?? ''}</span>
      </div>
      {cells.map((c) => {
        const isSel = selected?.date === date && selected.slot === c.slot;
        return (
          <button
            key={c.slot}
            type="button"
            onClick={() => onPick(c.slot)}
            aria-pressed={isSel}
            aria-label={`${formatServiceDate(date)} ${SLOT_LABEL[c.slot]}: ${CELL[c.state].label}`}
            data-testid={`cell-${date}-${c.slot}`}
            className={`min-h-11 rounded-lg px-2 py-1.5 text-left ring-1 ${CELL[c.state].tone} ${isSel ? 'outline outline-2 outline-brand-500' : ''}`}
          >
            <span className="block font-medium">{CELL[c.state].label}{c.qty > 1 ? ` ×${c.qty}` : ''}</span>
            {c.until && <span className="block text-[11px] opacity-75">till {c.until}</span>}
          </button>
        );
      })}
    </>
  );
}

function CellActions({ cell, sub, date, two, holds, today, busy, onChoose }: {
  cell: DeskCell; sub: DeskSub; date: string; two: boolean; holds: Hold[]; today: string; busy: boolean;
  onChoose: (a: Action) => void;
}) {
  const btn = (a: Action, testId: string, variant: 'primary' | 'secondary' = 'secondary') => (
    <Button key={testId} variant={variant} className="px-3 py-1" disabled={busy} onClick={() => onChoose(a)} data-testid={testId}>{a.label}</Button>
  );
  const hold = cell.holdId ? holds.find((h) => h.change_id === cell.holdId) : undefined;
  const actions: ReactNode[] = [];
  switch (cell.state) {
    case 'open':
    case 'locked':
      actions.push(btn({ kind: 'skip', subId: sub.id, from: date, slot: cell.slot, label: 'Skip this meal' }, 'act-skip', 'primary'));
      if (two) actions.push(btn({ kind: 'skip_day', subId: sub.id, from: date, slot: null, label: 'Skip the whole day' }, 'act-skip-day'));
      actions.push(btn({ kind: 'pause', subId: sub.id, from: date, slot: null, label: 'Pause from here' }, 'act-pause'));
      break;
    case 'late_charged':
      actions.push(btn({ kind: 'waive', subId: sub.id, from: date, slot: cell.slot, label: 'Don’t charge this meal' }, 'act-waive', 'primary'));
      break;
    case 'skipped':
    case 'paused':
      if (hold && !cell.frozen) {
        actions.push(btn({ kind: 'undo', subId: sub.id, from: date, slot: cell.slot, holdId: hold.change_id,
          label: `Undo ${hold.type === 'pause' ? 'pause' : 'skip'} ${holdDates(hold)}` }, 'act-undo', 'primary'));
      }
      if (cell.state === 'paused' && sub.status === 'paused' && !cell.frozen) {
        actions.push(btn({ kind: 'resume', subId: sub.id, from: date < today ? today : date, slot: null, label: 'Resume' }, 'act-resume'));
      }
      break;
    default:
      break;
  }
  if (actions.length === 0) {
    const why: Partial<Record<CellState, string>> = {
      on_way: 'Already with the rider: nothing to change.',
      delivered: 'Already delivered.',
      failed: 'The delivery failed: see the Delivery page.',
      late_waived: 'Skipped and not charged. Nothing else to do.',
      closed: 'The kitchen is closed for this meal.',
      weekly_off: 'The kitchen’s day off.',
      none: 'No meal is planned here (not in the plan, or before it starts).',
      skipped: cell.frozen ? 'Skipped, past its cutoff: it cannot come back any more.' : 'Skipped. Undo it from the list below.',
      paused: cell.frozen ? 'Paused, past its cutoff: it cannot come back any more.' : 'Paused. Undo it from the list below.',
    };
    return <p className="text-ink-600">{why[cell.state] ?? 'Nothing to change.'}</p>;
  }
  return <div className="flex flex-wrap gap-1.5">{actions}</div>;
}
