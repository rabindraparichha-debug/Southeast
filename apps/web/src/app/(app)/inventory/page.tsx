import { formatPaise } from '@tiffin/core';
import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { friendlyError } from '@/lib/errors';
import { formatDay, formatQty, formatSignedQty, type InventoryAlert } from '@/lib/inventory';
import { Alert, Badge, Card, PageHeader } from '@/components/ui';
import { PrintButton } from '@/components/print-button';
import { InventoryTabs } from './tabs';
import { StockList, type StockRow } from './stock-list';
import { NewItemForm } from './new-item-form';

// Stock list with alerts. Values at cost are owner-only (staff: no money), so they are
// stripped here before anything reaches the browser.
export default async function InventoryPage() {
  const { kitchen } = await requireKitchen(['owner', 'staff']);
  const isOwner = kitchen.role === 'owner';
  const supabase = await createClient();
  const [{ data: levels, error }, { data: alertsRaw }] = await Promise.all([
    supabase.rpc('stock_levels', { p_kitchen: kitchen.kitchenId }),
    supabase.rpc('inventory_alerts', { p_kitchen: kitchen.kitchenId }),
  ]);
  const rows: StockRow[] = (levels ?? []).map((r) => ({
    item_id: r.item_id, name: r.name, unit: r.unit, category: r.category, stock: Number(r.stock), min_qty: Number(r.min_qty),
    low: r.low, active: r.active, value_paise: isOwner ? r.value_paise : null, unit_cost_paise: isOwner ? r.unit_cost_paise : null,
  }));
  const alerts = (alertsRaw as unknown as InventoryAlert[] | null) ?? [];
  const totalValue = rows.reduce((t, r) => t + (r.active ? r.value_paise ?? 0 : 0), 0);
  const lowCount = rows.filter((r) => r.low && r.active).length;

  return (
    <>
      <PageHeader
        title="Inventory"
        subtitle={
          <span>
            {rows.filter((r) => r.active).length} items · {lowCount ? `${lowCount} low` : 'nothing low'}
            {isOwner && ` · stock value ${formatPaise(totalValue)}`}
          </span>
        }
        actions={<PrintButton />}
      />
      <InventoryTabs />
      {error && <Alert>{friendlyError(error)}</Alert>}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <StockList rows={rows} isOwner={isOwner} />
        </div>
        <div className="min-w-0 space-y-6 print:hidden">
          <Card title={`Alerts${alerts.length ? ` (${alerts.length})` : ''}`}>
            {alerts.length === 0 ? (
              <p className="text-sm text-ink-500">No alerts. Low stock, price jumps and big stock-take differences show here.</p>
            ) : (
              <ul className="space-y-2 text-sm" data-testid="alerts">
                {alerts.map((a, i) => (
                  <li key={i} className="flex items-start gap-2">
                    {a.type === 'low_stock' && (
                      <>
                        <Badge tone="red">Low</Badge>
                        <span><strong>{a.item}</strong>: {formatQty(a.stock, a.unit)} left (minimum {formatQty(a.min_qty, a.unit)})</span>
                      </>
                    )}
                    {a.type === 'price_jump' && (
                      <>
                        <Badge tone="amber">Price</Badge>
                        <span>
                          <strong>{a.item}</strong> up {Number(a.pct).toFixed(0)}% on {formatDay(a.bill_date)}
                          {a.unit_price_paise != null && ` (now ${formatPaise(a.unit_price_paise)}/${a.unit})`}
                        </span>
                      </>
                    )}
                    {a.type === 'variance' && (
                      <>
                        <Badge tone="blue">Count</Badge>
                        <span>
                          <strong>{a.item}</strong> counted {formatSignedQty(a.variance, a.unit)} ({a.pct}%) on {formatDay(a.date)}
                          {a.reason && ` — ${a.reason}`}
                        </span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <NewItemForm kitchenId={kitchen.kitchenId} />
        </div>
      </div>
    </>
  );
}
