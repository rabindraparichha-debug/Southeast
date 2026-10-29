import { formatPaise, istDate } from '@tiffin/core';
import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { friendlyError } from '@/lib/errors';
import { formatDay, type CostReport } from '@/lib/inventory';
import { Alert, Card, PageHeader, Stat } from '@/components/ui';
import { PrintButton } from '@/components/print-button';
import { CostSettings } from './cost-settings';

const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
// by_day ingredients_paise arrives unrounded (fractional paise) from cost_report; round before formatting.
const money = (p: number | null | undefined) => (p == null ? '—' : formatPaise(Math.round(Number(p))));

// Cost per meal and margin (owner only): ingredients consumed at lock + waste + stock-take
// losses + gas and packaging per meal, against revenue from counted meals.
export default async function CostsPage({ searchParams }: PageProps<'/reports/costs'>) {
  const { kitchen } = await requireKitchen(['owner']);
  const sp = await searchParams;
  const today = istDate();
  const from = isDate(sp.from) ? sp.from : `${today.slice(0, 8)}01`;
  const to = isDate(sp.to) && sp.to >= from ? sp.to : today;
  const supabase = await createClient();
  const [{ data, error }, { data: settings }] = await Promise.all([
    supabase.rpc('cost_report', { p_kitchen: kitchen.kitchenId, p_from: from, p_to: to }),
    supabase.from('kitchen_settings').select('gas_paise_per_meal, packaging_paise_per_meal, variance_reason_pct, price_jump_pct')
      .eq('kitchen_id', kitchen.kitchenId).single(),
  ]);
  const r = data as unknown as CostReport | null;
  const marginTone = r?.margin_per_meal_paise != null && r.margin_per_meal_paise < 0 ? 'text-red-700' : '';
  const breakdown: [string, number, string?][] = r ? [
    ['Ingredients (recipes at lock)', r.ingredients_paise],
    ['Waste', r.waste_paise],
    ['Stock-take loss', r.stock_loss_paise, r.stock_loss_paise < 0 ? 'Counted more than expected; gains are not subtracted from cost.' : undefined],
    ['Gas', r.gas_paise],
    ['Packaging', r.packaging_paise],
  ] : [];

  return (
    <>
      <PageHeader
        title="Costs and margin"
        subtitle={`${formatDay(from)} – ${formatDay(to)} · locked meals only`}
        actions={
          <form className="flex flex-wrap items-center gap-2 print:hidden">
            <input type="date" name="from" defaultValue={from} max={today} aria-label="From" className="rounded-lg px-2 py-1.5 text-sm ring-1 ring-ink-200" />
            <span className="text-sm text-ink-500">to</span>
            <input type="date" name="to" defaultValue={to} aria-label="To" className="rounded-lg px-2 py-1.5 text-sm ring-1 ring-ink-200" />
            <button className="rounded-lg bg-white px-3 py-1.5 text-sm ring-1 ring-ink-200 hover:bg-ink-50">Show</button>
            <PrintButton />
          </form>
        }
      />
      {error && <Alert>{friendlyError(error)}</Alert>}
      {r && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="cost-cards">
            <Stat label="Cost per meal" value={money(r.cost_per_meal_paise)} hint={`${r.meals} meals · total ${money(r.total_cost_paise)}`} />
            <Stat label="Revenue per meal" value={money(r.revenue_per_meal_paise)} hint={`Revenue ${money(r.revenue_paise)}`} />
            <Stat label="Margin per meal" value={<span className={marginTone}>{money(r.margin_per_meal_paise)}</span>} />
            <Stat label="Margin" value={<span className={marginTone}>{r.margin_pct == null ? '—' : `${r.margin_pct}%`}</span>} hint="of revenue" />
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-3">
            <Card title="Where the money goes">
              <ul className="space-y-2 text-sm">
                {breakdown.map(([label, paise, hint]) => (
                  <li key={label}>
                    <div className="flex justify-between"><span>{label}</span><strong className="tabular-nums">{money(paise)}</strong></div>
                    {r.meals > 0 && <div className="text-right text-xs text-ink-500">{money(Math.round(paise / r.meals))} per meal</div>}
                    {hint && <div className="text-xs text-ink-500">{hint}</div>}
                  </li>
                ))}
                <li className="flex justify-between border-t border-ink-100 pt-2"><span className="font-medium">Total cost</span><strong className="tabular-nums">{money(r.total_cost_paise)}</strong></li>
              </ul>
            </Card>
            <Card title="By day" className="overflow-x-auto lg:col-span-2">
              <table className="min-w-full text-sm" data-testid="by-day">
                <thead className="border-b border-ink-100 text-left text-xs uppercase text-ink-500">
                  <tr><th className="py-2 pr-3">Date</th><th className="py-2 pr-3 text-right">Meals</th><th className="py-2 pr-3 text-right">Ingredients</th><th className="py-2 text-right">Per meal</th></tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {r.by_day.map((d) => (
                    <tr key={d.date}>
                      <td className="py-2 pr-3">{formatDay(d.date)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{d.meals}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{money(d.ingredients_paise)}</td>
                      <td className="py-2 text-right tabular-nums">{d.meals ? money(Math.round(Number(d.ingredients_paise) / d.meals)) : '—'}</td>
                    </tr>
                  ))}
                  {r.by_day.length === 0 && <tr><td colSpan={4} className="py-6 text-center text-ink-500">No locked meals in this range.</td></tr>}
                </tbody>
              </table>
              <p className="mt-3 text-xs text-ink-500">Ingredient cost is the recipe quantity × portions, deducted when each meal locks. Add recipes for every menu dish for accurate numbers.</p>
            </Card>
          </div>
        </>
      )}
      {settings && (
        <div className="mt-6 print:hidden">
          <CostSettings
            kitchenId={kitchen.kitchenId}
            initial={{
              gas: settings.gas_paise_per_meal, packaging: settings.packaging_paise_per_meal,
              variancePct: Number(settings.variance_reason_pct), priceJumpPct: Number(settings.price_jump_pct),
            }}
          />
        </div>
      )}
    </>
  );
}
