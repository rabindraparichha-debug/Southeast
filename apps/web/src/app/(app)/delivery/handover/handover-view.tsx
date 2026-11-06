'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { SLOT_LABEL, formatIstShort, formatPaise, formatServiceDate } from '@tiffin/core';
import type { MealSlot } from '@tiffin/db';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { FAIL_REASON_LABEL } from '@/lib/delivery';
import { Alert, Badge, Button, Card, Input } from '@/components/ui';

export type Collector = {
  user_id: string; name: string; role: string | null;
  pending_count: number; pending_paise: number; confirmed_count: number; confirmed_paise: number;
  rejected_count: number; rejected_paise: number;
  pending: { payment_id: string; customer_name: string; amount_paise: number; collected_at: string; service_date: string | null; slot: MealSlot | null }[];
};
export type CreditRequest = {
  stop_id: string; service_date: string; slot: MealSlot; route_name: string; customer_name: string; office: boolean;
  reason: string; note: string | null; done_at: string; rider_name: string | null; meals: number; amount_paise: number;
  credit_status: 'pending' | 'approved' | 'rejected'; credit_note: string | null; decided_at: string | null; decided_by_name: string | null;
};

const STATUS_TONE = { pending: 'amber', approved: 'green', rejected: 'gray' } as const;
const STATUS_LABEL = { pending: 'Waiting', approved: 'Credited', rejected: 'Refused' } as const;

export function HandoverView({ kitchenId, collectors, credits }: { kitchenId: string; collectors: Collector[]; credits: CreditRequest[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'red' | 'green'; text: string } | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const waiting = credits.filter((c) => c.credit_status === 'pending');
  const decided = credits.filter((c) => c.credit_status !== 'pending');
  const holding = collectors.filter((c) => c.pending_count > 0);

  async function decide(c: CreditRequest, approve: boolean) {
    setBusy(c.stop_id);
    const { error } = await supabaseBrowser().rpc('decide_stop_credit', { p_stop: c.stop_id, p_approve: approve, p_note: notes[c.stop_id] || undefined });
    setBusy(null);
    setMsg(error ? { tone: 'red', text: friendlyError(error) }
      : { tone: 'green', text: approve ? `${c.customer_name} gets ${c.meals} meal(s) back.` : `Credit for ${c.customer_name} refused.` });
    router.refresh();
  }

  async function confirm(c: Collector, paymentIds?: string[]) {
    setBusy(c.user_id);
    const { data, error } = await supabaseBrowser().rpc('confirm_rider_cash', {
      p_kitchen: kitchenId, p_rider: c.user_id, p_payment_ids: paymentIds ?? c.pending.map((p) => p.payment_id),
    });
    setBusy(null);
    const paise = Number((data as { paise?: number } | null)?.paise ?? 0);
    setMsg(error ? { tone: 'red', text: friendlyError(error) } : { tone: 'green', text: `Received ${formatPaise(paise)} from ${c.name}.` });
    router.refresh();
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {msg && <div className="lg:col-span-2"><Alert tone={msg.tone}>{msg.text}</Alert></div>}

      <Card title={`Cash with riders${holding.length ? ` · ${formatPaise(holding.reduce((t, c) => t + c.pending_paise, 0))}` : ''}`}>
        {holding.length === 0 && <p className="text-sm text-ink-500">No cash is waiting to be handed over.</p>}
        <ul className="divide-y divide-ink-100">
          {holding.map((c) => (
            <li key={c.user_id} className="space-y-2 py-3" data-testid="cash-collector">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-ink-900">{c.name}</span>
                <Button onClick={() => confirm(c)} disabled={busy === c.user_id}>Received {formatPaise(c.pending_paise)}</Button>
              </div>
              <ul className="space-y-1 text-sm text-ink-600">
                {c.pending.map((p) => (
                  <li key={p.payment_id} className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {p.customer_name} · {formatPaise(p.amount_paise)}
                      <span className="text-xs text-ink-500"> · {p.service_date ? `${formatServiceDate(p.service_date)} ${p.slot ? SLOT_LABEL[p.slot] : ''}` : formatIstShort(p.collected_at)}</span>
                    </span>
                    <button type="button" className="text-xs font-medium text-brand-700 hover:underline" disabled={busy === c.user_id}
                      onClick={() => confirm(c, [p.payment_id])}>Only this one</button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
        {collectors.some((c) => c.confirmed_count > 0 || c.rejected_count > 0) && (
          <div className="mt-4 border-t border-ink-100 pt-3 text-xs text-ink-500">
            Last 7 days: {collectors.filter((c) => c.confirmed_count > 0 || c.rejected_count > 0)
              .map((c) => `${c.name} ${formatPaise(c.confirmed_paise)} confirmed${c.rejected_paise ? `, ${formatPaise(c.rejected_paise)} rejected` : ''}`).join(' · ')}
          </div>
        )}
        <p className="mt-3 text-xs text-ink-500">To reject a single payment, open the customer’s money panel.</p>
      </Card>

      <Card title={`Credits to decide${waiting.length ? ` · ${waiting.length}` : ''}`}>
        {waiting.length === 0 && <p className="text-sm text-ink-500">Nothing waiting. When a rider marks a delivery failed because of the kitchen, it shows here.</p>}
        <ul className="divide-y divide-ink-100">
          {waiting.map((c) => (
            <li key={c.stop_id} className="space-y-2 py-3" data-testid="credit-request">
              <div className="text-sm">
                <span className="font-medium text-ink-900">{c.office ? '🏢 ' : ''}{c.customer_name}</span>
                <span className="text-ink-600"> · {formatServiceDate(c.service_date)} {SLOT_LABEL[c.slot]} · {c.route_name}</span>
              </div>
              <div className="text-sm text-ink-600">
                {c.rider_name ?? 'Rider'}: {FAIL_REASON_LABEL[c.reason] ?? c.reason}{c.note ? ` (“${c.note}”)` : ''} · {c.meals} meal(s), {formatPaise(c.amount_paise)}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Input aria-label="Note (optional)" placeholder="Note (optional)" className="max-w-xs" value={notes[c.stop_id] ?? ''}
                  onChange={(e) => setNotes({ ...notes, [c.stop_id]: e.target.value })} />
                <Button onClick={() => decide(c, true)} disabled={busy === c.stop_id}>Give back</Button>
                <Button variant="secondary" onClick={() => decide(c, false)} disabled={busy === c.stop_id}>Refuse</Button>
              </div>
            </li>
          ))}
        </ul>
        {decided.length > 0 && (
          <>
            <h3 className="mt-4 border-t border-ink-100 pt-3 text-sm font-medium text-ink-700">Decided (14 days)</h3>
            <ul className="mt-2 space-y-1 text-sm text-ink-600">
              {decided.map((c) => (
                <li key={c.stop_id} className="flex flex-wrap items-center gap-2">
                  <Badge tone={STATUS_TONE[c.credit_status]}>{STATUS_LABEL[c.credit_status]}</Badge>
                  {c.customer_name} · {formatServiceDate(c.service_date)} {SLOT_LABEL[c.slot]} · {FAIL_REASON_LABEL[c.reason] ?? c.reason}
                  {c.decided_by_name ? <span className="text-xs text-ink-500">by {c.decided_by_name}</span> : null}
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </div>
  );
}
