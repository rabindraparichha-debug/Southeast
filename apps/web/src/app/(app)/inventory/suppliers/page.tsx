import { formatPaise } from '@tiffin/core';
import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { friendlyError } from '@/lib/errors';
import { formatIstDateTime } from '@/lib/inventory';
import { Alert, Card, PageHeader, Stat } from '@/components/ui';
import { InventoryTabs } from '../tabs';
import { SupplierManager, type SupplierRow } from './supplier-manager';

const METHOD_LABEL: Record<string, string> = { cash: 'Cash', upi_manual: 'UPI', bank_transfer: 'Bank transfer' };

// Suppliers: staff can add and edit them; dues and payments are money, owner only
// (supplier_dues / pay_supplier refuse staff, and supplier_payments RLS hides them).
export default async function SuppliersPage() {
  const { kitchen } = await requireKitchen(['owner', 'staff']);
  const isOwner = kitchen.role === 'owner';
  const supabase = await createClient();
  const [{ data: suppliers, error }, dues, payments] = await Promise.all([
    supabase.from('suppliers').select('id, name, phone, notes, active').eq('kitchen_id', kitchen.kitchenId).order('name'),
    isOwner ? supabase.rpc('supplier_dues', { p_kitchen: kitchen.kitchenId }) : Promise.resolve({ data: null, error: null }),
    isOwner
      ? supabase.from('supplier_payments').select('id, amount_paise, method, note, paid_at, supplier:suppliers(name)')
          .eq('kitchen_id', kitchen.kitchenId).order('paid_at', { ascending: false }).limit(20)
      : Promise.resolve({ data: null, error: null }),
  ]);
  const dueBy = new Map((dues.data ?? []).map((d) => [d.supplier_id, d]));
  const rows: SupplierRow[] = (suppliers ?? []).map((s) => {
    const d = dueBy.get(s.id);
    return {
      id: s.id, name: s.name, phone: s.phone, notes: s.notes, active: s.active,
      due: isOwner && d ? { purchased_paise: d.purchased_paise, paid_paise: d.paid_paise, due_paise: d.due_paise, last_bill_date: d.last_bill_date } : null,
    };
  });
  // Biggest dues first for the owner.
  if (isOwner) rows.sort((a, b) => (b.due?.due_paise ?? 0) - (a.due?.due_paise ?? 0) || a.name.localeCompare(b.name));
  const totalDue = (dues.data ?? []).reduce((t, d) => t + Math.max(d.due_paise, 0), 0);

  return (
    <>
      <PageHeader title="Suppliers" subtitle={isOwner ? 'Who you buy from, what you owe them, and payments.' : 'Who the kitchen buys from.'} />
      <InventoryTabs />
      {(error || dues.error) && <Alert>{friendlyError(error ?? dues.error)}</Alert>}
      {isOwner && (
        <div className="mb-6 grid gap-4 sm:grid-cols-3">
          <Stat label="Total due to suppliers" value={formatPaise(totalDue)} />
          <Stat label="Suppliers with dues" value={(dues.data ?? []).filter((d) => d.due_paise > 0).length} />
        </div>
      )}
      <SupplierManager kitchenId={kitchen.kitchenId} isOwner={isOwner} rows={rows} />
      {isOwner && (
        <Card title="Recent payments" className="mt-6 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="border-b border-ink-100 text-left text-xs uppercase text-ink-500">
              <tr><th className="py-2 pr-3">When</th><th className="py-2 pr-3">Supplier</th><th className="py-2 pr-3">Method</th><th className="py-2 pr-3">Note</th><th className="py-2 text-right">Amount</th></tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {(payments.data ?? []).map((p) => (
                <tr key={p.id}>
                  <td className="py-2 pr-3 whitespace-nowrap">{formatIstDateTime(p.paid_at)}</td>
                  <td className="py-2 pr-3">{p.supplier?.name}</td>
                  <td className="py-2 pr-3">{METHOD_LABEL[p.method] ?? p.method}</td>
                  <td className="py-2 pr-3 text-ink-600">{p.note}</td>
                  <td className="py-2 text-right tabular-nums">{formatPaise(p.amount_paise)}</td>
                </tr>
              ))}
              {!payments.data?.length && <tr><td colSpan={5} className="py-6 text-center text-ink-500">No payments yet.</td></tr>}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
