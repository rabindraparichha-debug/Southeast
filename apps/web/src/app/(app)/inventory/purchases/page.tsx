import { formatPaise, istDate } from '@tiffin/core';
import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { friendlyError } from '@/lib/errors';
import { formatDay, formatQty } from '@/lib/inventory';
import { Alert, Badge, Card, PageHeader } from '@/components/ui';
import { InventoryTabs } from '../tabs';
import { PurchaseForm } from './purchase-form';

// Supplier bills. Staff record bills too (they enter the amounts), so totals show for both roles;
// paying the supplier with the bill is owner-only.
export default async function PurchasesPage() {
  const { kitchen } = await requireKitchen(['owner', 'staff']);
  const isOwner = kitchen.role === 'owner';
  const supabase = await createClient();
  const [{ data: purchases, error }, { data: items }, { data: suppliers }] = await Promise.all([
    supabase.from('purchases')
      .select('id, bill_date, bill_no, bill_photo_path, total_paise, notes, supplier:suppliers(name), lines:purchase_lines(id, qty, amount_paise, price_jump_pct, item:items(name, unit))')
      .eq('kitchen_id', kitchen.kitchenId)
      .order('bill_date', { ascending: false }).order('created_at', { ascending: false })
      .limit(60),
    supabase.from('items').select('id, name, unit').eq('kitchen_id', kitchen.kitchenId).eq('active', true).order('name'),
    supabase.from('suppliers').select('id, name').eq('kitchen_id', kitchen.kitchenId).eq('active', true).order('name'),
  ]);
  const rows = purchases ?? [];

  // Bills are in a private bucket: short-lived signed links, created with the user's session (storage RLS applies).
  const paths = rows.map((p) => p.bill_photo_path).filter((p): p is string => Boolean(p));
  const signed = new Map<string, string>();
  if (paths.length) {
    const { data } = await supabase.storage.from('bills').createSignedUrls(paths, 3600);
    for (const s of data ?? []) if (s.path && s.signedUrl) signed.set(s.path, s.signedUrl);
  }

  return (
    <>
      <PageHeader title="Purchases" subtitle="Supplier bills. Each bill adds its items to stock." />
      <InventoryTabs />
      {error && <Alert>{friendlyError(error)}</Alert>}
      <div className="grid gap-6 xl:grid-cols-5">
        <div className="min-w-0 xl:col-span-2">
          <PurchaseForm kitchenId={kitchen.kitchenId} isOwner={isOwner} today={istDate()} items={items ?? []} suppliers={suppliers ?? []} />
        </div>
        <Card title={`Bills (${rows.length})`} className="min-w-0 overflow-x-auto xl:col-span-3">
          <table className="min-w-full text-sm" data-testid="bills-table">
            <thead className="border-b border-ink-100 text-left text-xs uppercase text-ink-500">
              <tr>
                <th className="py-2 pr-3">Date</th>
                <th className="py-2 pr-3">Supplier</th>
                <th className="py-2 pr-3">Bill no</th>
                <th className="py-2 pr-3">Items</th>
                <th className="py-2 pr-3 text-right">Total</th>
                <th className="py-2">Photo</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {rows.map((p) => {
                const jumps = p.lines.filter((l) => l.price_jump_pct != null);
                const url = p.bill_photo_path ? signed.get(p.bill_photo_path) : undefined;
                return (
                  <tr key={p.id} className="align-top">
                    <td className="py-2 pr-3 whitespace-nowrap">{formatDay(p.bill_date)}</td>
                    <td className="py-2 pr-3">{p.supplier?.name ?? <span className="text-ink-400">—</span>}</td>
                    <td className="py-2 pr-3">{p.bill_no ?? <span className="text-ink-400">—</span>}</td>
                    <td className="py-2 pr-3">
                      <details>
                        <summary className="cursor-pointer text-ink-700">{p.lines.length} item{p.lines.length === 1 ? '' : 's'}</summary>
                        <ul className="mt-1 space-y-0.5 text-xs text-ink-600">
                          {p.lines.map((l) => (
                            <li key={l.id}>{l.item?.name}: {formatQty(l.qty, l.item?.unit ?? 'pc')} · {formatPaise(l.amount_paise)}</li>
                          ))}
                        </ul>
                        {p.notes && <p className="mt-1 text-xs text-ink-500">{p.notes}</p>}
                      </details>
                      {jumps.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {jumps.map((l) => <Badge key={l.id} tone="amber">{l.item?.name} +{Number(l.price_jump_pct).toFixed(0)}%</Badge>)}
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{formatPaise(p.total_paise)}</td>
                    <td className="py-2">
                      {url ? <a href={url} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">View</a> : <span className="text-ink-400">—</span>}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-ink-500">No bills yet.</td></tr>}
            </tbody>
          </table>
        </Card>
      </div>
    </>
  );
}
