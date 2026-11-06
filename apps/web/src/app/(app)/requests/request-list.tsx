'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { SLOT_LABEL, formatServiceDate } from '@tiffin/core';
import type { ChangeResult } from '@tiffin/db';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import type { ChangeRequestRow } from '@/lib/money';
import { Alert, Badge, Button, Card, Field, Input, Select } from '@/components/ui';

export type Choice = { id: string; label: string };

const TYPE_LABEL: Record<ChangeRequestRow['type'], string> = {
  skip: 'Skip', pause: 'Pause', resume: 'Resume', cancel: 'Cancel', address: 'New address',
};
const STATUS_TONE = { pending: 'amber', approved: 'green', rejected: 'gray' } as const;
const STATUS_LABEL = { pending: 'Waiting', approved: 'Approved', rejected: 'Rejected' } as const;

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

function dates(r: ChangeRequestRow): string {
  const slot = r.slot ? ` · ${SLOT_LABEL[r.slot]} only` : '';
  if (r.type === 'cancel') return `Last meal the day before ${formatServiceDate(r.from_date)}`;
  if (r.type === 'resume') return `From ${formatServiceDate(r.from_date)}${slot}`;
  if (!r.to_date) return `From ${formatServiceDate(r.from_date)}, open-ended${slot}`;
  if (r.to_date === r.from_date) return `${formatServiceDate(r.from_date)}${slot}`;
  return `${formatServiceDate(r.from_date)} – ${formatServiceDate(r.to_date)}${slot}`;
}

export function RequestList({ rows, plans, addresses }: {
  rows: ChangeRequestRow[]; plans: Record<string, Choice[]>; addresses: Record<string, Choice[]>;
}) {
  if (rows.length === 0) {
    return <Card><p className="text-sm text-ink-500">No requests waiting. Riders record skips, pauses and new addresses from their stop screen.</p></Card>;
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2" data-testid="request-list">
      {rows.map((r) => <RequestCard key={r.id} r={r} plans={plans[r.customer_id] ?? []} addresses={addresses[r.customer_id] ?? []} />)}
    </div>
  );
}

function RequestCard({ r, plans, addresses }: { r: ChangeRequestRow; plans: Choice[]; addresses: Choice[] }) {
  const router = useRouter();
  const [sub, setSub] = useState(r.subscription_id ?? (plans.length === 1 ? plans[0]!.id : ''));
  // No preselection: the rider wrote the new address in words; the approver picks the saved one.
  const [address, setAddress] = useState('');
  const [waive, setWaive] = useState(false);
  const [preview, setPreview] = useState<ChangeResult | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = r.status === 'pending';

  async function approve(dryRun: boolean, waiveLate = waive) {
    setBusy(true);
    setError('');
    const { data, error } = await supabaseBrowser().rpc('approve_change_request', {
      p_request: r.id,
      p_waive_late: waiveLate,
      p_dry_run: dryRun,
      p_subscription: r.subscription_id ? undefined : sub || undefined,
      p_address: r.type === 'address' ? address || undefined : undefined,
    });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    if (dryRun) return setPreview(data as unknown as ChangeResult);
    setDone('Approved and applied.');
    router.refresh();
  }

  async function reject() {
    setBusy(true);
    setError('');
    const { error } = await supabaseBrowser().rpc('reject_change_request', { p_request: r.id, p_reason: reason.trim() || undefined });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    setDone('Rejected.');
    router.refresh();
  }

  const late = preview?.affected.filter((a) => a.late) ?? [];
  const charged = preview?.affected.filter((a) => a.charged) ?? [];

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          <Link href={`/customers/${r.customer_id}`} className="hover:text-brand-700">{r.customer_name}</Link>
          <Badge tone="blue">{TYPE_LABEL[r.type]}</Badge>
        </span>
      }
      actions={<Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>}
    >
      <div className="space-y-1 text-sm">
        <p className="font-medium">{dates(r)}</p>
        {r.note && <p className="text-ink-700">“{r.note}”</p>}
        <p className="text-ink-500">
          From {r.requested_by_name || 'a rider'} · {when(r.requested_at)}{r.plan_name ? ` · ${r.plan_name}` : ''}
        </p>
        {!pending && (
          <p className="text-ink-500">
            {STATUS_LABEL[r.status]}{r.decided_at ? ` ${when(r.decided_at)}` : ''}{r.decision_note ? ` · ${r.decision_note}` : ''}
          </p>
        )}
      </div>

      {pending && !done && (
        <div className="mt-3 space-y-3">
          {!r.subscription_id && (
            <Field label="Which plan?" hint="This customer has more than one plan.">
              <Select value={sub} onChange={(e) => { setSub(e.target.value); setPreview(null); }}>
                <option value="">Choose…</option>
                {plans.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </Select>
            </Field>
          )}
          {r.type === 'address' && (
            addresses.length ? (
              <Field label="Deliver to" hint={<>Not in the list? <Link href={`/customers/${r.customer_id}`} className="text-brand-700 hover:underline">Add the new address</Link> first.</>}>
                <Select value={address} onChange={(e) => { setAddress(e.target.value); setPreview(null); }}>
                  <option value="">Choose the new address…</option>
                  {addresses.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </Select>
              </Field>
            ) : (
              <Alert tone="amber">
                <Link href={`/customers/${r.customer_id}`} className="underline">Add the new address</Link> on the customer page first, then approve.
              </Alert>
            )
          )}

          {preview && (
            <div className="space-y-2 rounded-lg bg-ink-50 p-3 text-sm ring-1 ring-ink-200" data-testid="request-preview">
              <p>
                {preview.affected.length === 0
                  ? 'No generated meals are affected yet (later meals follow the change automatically).'
                  : `Affects ${preview.affected.length} meal${preview.affected.length > 1 ? 's' : ''}: ${preview.affected
                      .slice(0, 6).map((a) => `${formatServiceDate(a.date)} ${SLOT_LABEL[a.slot]}`).join(', ')}${preview.affected.length > 6 ? '…' : ''}`}
              </p>
              {charged.length > 0 && (
                <Alert tone="amber">
                  {charged.length} meal{charged.length > 1 ? 's are' : ' is'} past the cutoff and will still be charged.
                </Alert>
              )}
              {late.length > 0 && (r.type === 'skip' || r.type === 'pause') && (
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={waive} onChange={(e) => { setWaive(e.target.checked); void approve(true, e.target.checked); }} />
                  Don’t charge the late meals
                </label>
              )}
            </div>
          )}

          {rejecting ? (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Reason (optional)" className="min-w-48 flex-1">
                <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Customer called and changed their mind" />
              </Field>
              <Button variant="danger" onClick={reject} disabled={busy}>Reject</Button>
              <Button variant="ghost" onClick={() => setRejecting(false)}>Back</Button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {!preview ? (
                <Button onClick={() => approve(true)} disabled={busy || (!r.subscription_id && !sub) || (r.type === 'address' && !address)}>
                  {busy ? 'Checking…' : 'Check'}
                </Button>
              ) : (
                <Button onClick={() => approve(false)} disabled={busy}>{busy ? 'Saving…' : 'Approve'}</Button>
              )}
              <Button variant="ghost" onClick={() => setRejecting(true)} disabled={busy}>Reject…</Button>
            </div>
          )}
        </div>
      )}
      {done && <div className="mt-3"><Alert tone="green">{done}</Alert></div>}
      {error && <div className="mt-3"><Alert>{error}</Alert></div>}
    </Card>
  );
}
