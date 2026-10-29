'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { formatIstDateTime } from '@/lib/delivery';
import { Alert, Badge, Button, Card, Field, Input, Select } from '@/components/ui';

type Balance = { customer_id: string; customer_name: string; area: string | null; outstanding: number; last_out_at: string | null; overdue: boolean };
type Customer = { id: string; name: string; area: string | null };

export function TiffinBoard({ balances, customers }: { balances: Balance[]; customers: Customer[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'red' | 'green'; text: string } | null>(null);
  const [f, setF] = useState({ customer: '', returned: '1', out: '0', note: '' });

  async function record(customer: string, returned: number, out: number, note: string | null, name: string) {
    setBusy(true);
    const { error } = await supabaseBrowser().rpc('record_tiffins', {
      p_customer: customer, p_returned: returned, p_out: out, p_note: note || undefined,
    });
    setBusy(false);
    if (error) {
      setMsg({ tone: 'red', text: friendlyError(error) });
      return false;
    }
    const parts = [returned ? `${returned} returned` : '', out ? `${out} given out` : ''].filter(Boolean).join(', ');
    setMsg({ tone: 'green', text: `${name}: ${parts}.` });
    router.refresh();
    return true;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const returned = Number(f.returned) || 0;
    const out = Number(f.out) || 0;
    const name = customers.find((c) => c.id === f.customer)?.name ?? 'Customer';
    if (await record(f.customer, returned, out, f.note.trim(), name)) setF({ customer: '', returned: '1', out: '0', note: '' });
  }

  const total = balances.reduce((t, b) => t + b.outstanding, 0);
  const overdue = balances.filter((b) => b.overdue).length;

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card
        className="overflow-x-auto lg:col-span-2"
        title={`With customers: ${total} tiffin(s)`}
        actions={overdue > 0 ? <Badge tone="red">{overdue} overdue</Badge> : undefined}
      >
        <table className="min-w-full text-sm">
          <thead className="border-b border-ink-100 text-left text-xs uppercase text-ink-500">
            <tr>
              <th className="py-2 pr-3">Customer</th>
              <th className="py-2 pr-3">Area</th>
              <th className="py-2 pr-3 text-right">Holding</th>
              <th className="py-2 pr-3">Last given</th>
              <th className="py-2 text-right">Returned at kitchen</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {balances.map((b) => (
              <tr key={b.customer_id} data-testid="tiffin-row" className={b.overdue ? 'bg-red-50' : ''}>
                <td className="py-2 pr-3 font-medium">
                  <Link href={`/customers/${b.customer_id}`} className="hover:text-brand-700">{b.customer_name}</Link>
                  {b.overdue && <span className="ml-2"><Badge tone="red">Overdue</Badge></span>}
                </td>
                <td className="py-2 pr-3 text-ink-600">{b.area ?? '—'}</td>
                <td className="py-2 pr-3 text-right font-semibold">{b.outstanding}</td>
                <td className="py-2 pr-3 text-ink-600">{b.last_out_at ? formatIstDateTime(b.last_out_at) : '—'}</td>
                <td className="py-2 text-right whitespace-nowrap">
                  <Button variant="ghost" className="px-2 py-1" disabled={busy} onClick={() => record(b.customer_id, 1, 0, 'Returned at kitchen', b.customer_name)}>1 back</Button>
                  {b.outstanding > 1 && (
                    <Button variant="ghost" className="px-2 py-1" disabled={busy}
                      onClick={() => record(b.customer_id, b.outstanding, 0, 'Returned at kitchen', b.customer_name)}>
                      All {b.outstanding} back
                    </Button>
                  )}
                </td>
              </tr>
            ))}
            {balances.length === 0 && (
              <tr><td colSpan={5} className="py-6 text-center text-ink-500">No tiffins with customers.</td></tr>
            )}
          </tbody>
        </table>
      </Card>

      <Card title="Record at the kitchen">
        <form onSubmit={submit} className="space-y-4">
          <Field label="Customer">
            <Select required value={f.customer} onChange={(e) => setF({ ...f, customer: e.target.value })}>
              <option value="">Choose…</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}{c.area ? ` · ${c.area}` : ''}</option>)}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Returned">
              <Input type="number" min={0} max={50} inputMode="numeric" value={f.returned} onChange={(e) => setF({ ...f, returned: e.target.value })} />
            </Field>
            <Field label="Given out" hint="Collected at the kitchen, or a correction.">
              <Input type="number" min={0} max={50} inputMode="numeric" value={f.out} onChange={(e) => setF({ ...f, out: e.target.value })} />
            </Field>
          </div>
          <Field label="Note (optional)">
            <Input value={f.note} maxLength={200} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="Dropped off by the customer" />
          </Field>
          <Button type="submit" disabled={busy}>Save</Button>
        </form>
        <div className="mt-3">{msg && <Alert tone={msg.tone}>{msg.text}</Alert>}</div>
      </Card>
    </div>
  );
}
