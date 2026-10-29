'use client';

import { Fragment, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { formatPaise, rupeesToPaise } from '@tiffin/core';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError, friendlyErrorIn } from '@/lib/errors';
import { formatDay } from '@/lib/inventory';
import { Alert, Button, Card, Field, Input, Select } from '@/components/ui';

export type SupplierRow = {
  id: string;
  name: string;
  phone: string | null;
  notes: string | null;
  active: boolean;
  /** Owner only. */
  due: { purchased_paise: number; paid_paise: number; due_paise: number; last_bill_date: string | null } | null;
};

type Action = { id: string; kind: 'edit' | 'pay' } | null;

export function SupplierManager({ kitchenId, isOwner, rows }: { kitchenId: string; isOwner: boolean; rows: SupplierRow[] }) {
  const [action, setAction] = useState<Action>(null);
  const [done, setDone] = useState('');
  const cols = isOwner ? 6 : 3;
  const finish = (m: string) => { setAction(null); setDone(m); };

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card title={`Suppliers (${rows.length})`} className="min-w-0 overflow-x-auto lg:col-span-2">
        {done && <div className="mb-3"><Alert tone="green">{done}</Alert></div>}
        <table className="min-w-full text-sm" data-testid="suppliers-table">
          <thead className="border-b border-ink-100 text-left text-xs uppercase text-ink-500">
            <tr>
              <th className="py-2 pr-3">Supplier</th>
              <th className="py-2 pr-3">Phone</th>
              {isOwner && <th className="py-2 pr-3 text-right">Bought</th>}
              {isOwner && <th className="py-2 pr-3 text-right">Due</th>}
              {isOwner && <th className="py-2 pr-3">Last bill</th>}
              <th className="py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.map((s) => (
              <Fragment key={s.id}>
                <tr data-supplier={s.name}>
                  <td className="py-2 pr-3 font-medium">{s.name}{s.notes && <div className="text-xs font-normal text-ink-500">{s.notes}</div>}</td>
                  <td className="py-2 pr-3">{s.phone ? <a href={`tel:${s.phone}`} className="text-brand-700 hover:underline">{s.phone}</a> : '—'}</td>
                  {isOwner && <td className="py-2 pr-3 text-right tabular-nums">{formatPaise(s.due?.purchased_paise ?? 0)}</td>}
                  {isOwner && (
                    <td className={`py-2 pr-3 text-right font-medium tabular-nums ${(s.due?.due_paise ?? 0) > 0 ? 'text-red-700' : ''}`} data-testid="due">
                      {formatPaise(s.due?.due_paise ?? 0)}
                    </td>
                  )}
                  {isOwner && <td className="py-2 pr-3 whitespace-nowrap">{s.due?.last_bill_date ? formatDay(s.due.last_bill_date) : '—'}</td>}
                  <td className="py-2 text-right whitespace-nowrap">
                    <button type="button" onClick={() => setAction(action?.id === s.id && action.kind === 'edit' ? null : { id: s.id, kind: 'edit' })}
                      className="ml-1 rounded-md bg-white px-2 py-1 text-xs font-medium ring-1 ring-ink-200 hover:bg-ink-50">Edit</button>
                    {isOwner && (
                      <button type="button" onClick={() => setAction(action?.id === s.id && action.kind === 'pay' ? null : { id: s.id, kind: 'pay' })}
                        className="ml-1 rounded-md bg-brand-600 px-2 py-1 text-xs font-medium text-white hover:bg-brand-700">Pay</button>
                    )}
                  </td>
                </tr>
                {action?.id === s.id && (
                  <tr className="bg-ink-50">
                    <td colSpan={cols} className="p-3">
                      {action.kind === 'edit' ? <SupplierForm kitchenId={kitchenId} row={s} onDone={finish} /> : <PayForm row={s} onDone={finish} />}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {rows.length === 0 && <tr><td colSpan={cols} className="py-6 text-center text-ink-500">No suppliers yet.</td></tr>}
          </tbody>
        </table>
      </Card>
      <Card title="Add supplier">
        <SupplierForm kitchenId={kitchenId} onDone={setDone} />
      </Card>
    </div>
  );
}

function SupplierForm({ kitchenId, row, onDone }: { kitchenId: string; row?: SupplierRow; onDone: (msg: string) => void }) {
  const router = useRouter();
  const [f, setF] = useState({ name: row?.name ?? '', phone: row?.phone ?? '', notes: row?.notes ?? '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!f.name.trim()) return setError('Name is required.');
    setBusy(true);
    const { error } = await supabaseBrowser().rpc('upsert_supplier', {
      p_kitchen: kitchenId, p_name: f.name.trim(), p_phone: f.phone.trim() || undefined, p_notes: f.notes.trim() || undefined, p_supplier: row?.id,
    });
    setBusy(false);
    if (error) return setError(friendlyErrorIn('supplier', error));
    onDone(row ? `${f.name.trim()} saved.` : `${f.name.trim()} added.`);
    if (!row) setF({ name: '', phone: '', notes: '' });
    router.refresh();
  }

  return (
    <form onSubmit={save} className={row ? 'flex flex-wrap items-end gap-3' : 'space-y-3'} aria-label={row ? `Edit ${row.name}` : 'Add supplier'}>
      <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={80} required /></Field>
      <Field label="Phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} inputMode="tel" maxLength={20} /></Field>
      <Field label="Notes" className={row ? 'flex-1' : ''}><Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={200} placeholder="e.g. Delivers Mon/Thu" /></Field>
      <Button disabled={busy} className={row ? '' : 'w-full'}>{row ? 'Save' : 'Add supplier'}</Button>
      {error && <span className="block w-full text-sm text-red-700">{error}</span>}
    </form>
  );
}

function PayForm({ row, onDone }: { row: SupplierRow; onDone: (msg: string) => void }) {
  const router = useRouter();
  const due = Math.max(row.due?.due_paise ?? 0, 0);
  const [amount, setAmount] = useState(due ? String(due / 100) : '');
  const [method, setMethod] = useState<'cash' | 'upi_manual' | 'bank_transfer'>('cash');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save(e: FormEvent) {
    e.preventDefault();
    setError('');
    const paise = rupeesToPaise(amount);
    if (!paise) return setError(friendlyError({ message: 'invalid_amount' }));
    setBusy(true);
    const { error } = await supabaseBrowser().rpc('pay_supplier', { p_supplier: row.id, p_amount_paise: paise, p_method: method, p_note: note.trim() || undefined });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    onDone(`Paid ${formatPaise(paise)} to ${row.name}.`);
    router.refresh();
  }

  return (
    <form onSubmit={save} className="flex flex-wrap items-end gap-3" aria-label={`Pay ${row.name}`}>
      <Field label="Amount (₹)" hint={due ? `Due ${formatPaise(due)}` : 'Nothing due'}>
        <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className="w-32!" aria-label="Amount" />
      </Field>
      <Field label="Method">
        <Select value={method} onChange={(e) => setMethod(e.target.value as typeof method)} className="w-36!">
          <option value="cash">Cash</option>
          <option value="upi_manual">UPI</option>
          <option value="bank_transfer">Bank transfer</option>
        </Select>
      </Field>
      <Field label="Note" className="flex-1"><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} /></Field>
      <Button disabled={busy}>Record payment</Button>
      {error && <span className="block w-full text-sm text-red-700">{error}</span>}
    </form>
  );
}
