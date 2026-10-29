import Link from 'next/link';
import { SLOT_LABEL, addDays, formatServiceDate, istDate, isIsoDate } from '@tiffin/core';
import type { MealSlot } from '@tiffin/db';
import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { friendlyError } from '@/lib/errors';
import { formatQty, formatQtySmart, type DishCost, type ProductionPlan } from '@/lib/inventory';
import { Alert, Badge, Card, PageHeader } from '@/components/ui';
import { PrintButton } from '@/components/print-button';
import { InventoryTabs } from '../tabs';
import { RecipeEditor } from './recipe-editor';

// Recipes per portion and the production plan for a slot. Cost per portion is owner-only
// (staff: no money), so it is stripped before reaching the browser.
export default async function RecipesPage({ searchParams }: PageProps<'/inventory/recipes'>) {
  const { kitchen } = await requireKitchen(['owner', 'staff']);
  const isOwner = kitchen.role === 'owner';
  const sp = await searchParams;
  // Same default as /sheet: tomorrow's lunch.
  const date = isIsoDate(sp.date) ? sp.date : addDays(istDate(), 1);
  const slot: MealSlot = sp.slot === 'dinner' ? 'dinner' : 'lunch';
  const newDish = typeof sp.new === 'string' ? sp.new.slice(0, 60) : '';
  const supabase = await createClient();

  const [{ data: costsRaw, error }, { data: planRaw, error: planError }, { data: items }] = await Promise.all([
    supabase.rpc('dish_costs', { p_kitchen: kitchen.kitchenId }),
    supabase.rpc('production_plan', { p_kitchen: kitchen.kitchenId, p_date: date, p_slot: slot }),
    supabase.from('items').select('id, name, unit').eq('kitchen_id', kitchen.kitchenId).eq('active', true).order('name'),
  ]);
  const dishes = ((costsRaw as unknown as DishCost[] | null) ?? []).map((d) =>
    isOwner ? d : { ...d, cost_per_portion_paise: null, lines: d.lines.map((l) => ({ ...l, cost_paise: null })) });
  const plan = planRaw as unknown as ProductionPlan | null;
  const totalPortions = plan?.dishes.reduce((t, d) => t + d.portions, 0) ?? 0;
  const prev = slot === 'dinner' ? { date, slot: 'lunch' } : { date: addDays(date, -1), slot: 'dinner' };
  const next = slot === 'lunch' ? { date, slot: 'dinner' } : { date: addDays(date, 1), slot: 'lunch' };

  return (
    <>
      <PageHeader title="Recipes" subtitle="Quantity per portion. Stock is deducted automatically when a meal locks." />
      <InventoryTabs />
      {error && <Alert>{friendlyError(error)}</Alert>}

      <Card
        title={<span id="plan">Production plan · {formatServiceDate(date)} · {SLOT_LABEL[slot]}</span>}
        className="mb-6"
      >
        <div className="mb-4 flex flex-wrap items-center gap-2 print:hidden">
          <Link href={`/inventory/recipes?date=${prev.date}&slot=${prev.slot}#plan`} className="rounded-lg px-3 py-1.5 text-sm ring-1 ring-ink-200 hover:bg-ink-50">←</Link>
          <form className="flex items-center gap-2">
            <input type="date" name="date" defaultValue={date} aria-label="Date" className="rounded-lg px-2 py-1.5 text-sm ring-1 ring-ink-200" />
            <select name="slot" defaultValue={slot} aria-label="Meal" className="rounded-lg px-2 py-1.5 text-sm ring-1 ring-ink-200">
              <option value="lunch">Lunch</option>
              <option value="dinner">Dinner</option>
            </select>
            <button className="rounded-lg bg-white px-3 py-1.5 text-sm ring-1 ring-ink-200 hover:bg-ink-50">Show</button>
          </form>
          <Link href={`/inventory/recipes?date=${next.date}&slot=${next.slot}#plan`} className="rounded-lg px-3 py-1.5 text-sm ring-1 ring-ink-200 hover:bg-ink-50">→</Link>
          <PrintButton />
        </div>
        {planError && <Alert>{friendlyError(planError)}</Alert>}
        {plan && (
          <div className="grid gap-6 md:grid-cols-3" data-testid="production-plan">
            <div>
              <h3 className="mb-2 text-sm font-semibold">Portions per dish {plan.consumed && <Badge tone="blue">Deducted at lock</Badge>}</h3>
              <ul className="space-y-1 text-sm">
                {plan.dishes.map((d) => <li key={d.dish_id} className="flex justify-between"><span>{d.name}</span><strong>{d.portions}</strong></li>)}
                {plan.dishes.length === 0 && <li className="text-ink-500">No menu dishes with a recipe.</li>}
              </ul>
              {totalPortions > 0 && <p className="mt-2 text-xs text-ink-500">{totalPortions} portions in all.</p>}
              {plan.no_recipe.length > 0 && (
                <div className="mt-4">
                  <h3 className="mb-1 text-sm font-semibold">On the menu without a recipe</h3>
                  <ul className="flex flex-wrap gap-1 text-sm" data-testid="no-recipe">
                    {plan.no_recipe.map((n) => (
                      <li key={n}>
                        <Link href={`/inventory/recipes?date=${date}&slot=${slot}&new=${encodeURIComponent(n)}#new-dish`}
                          className="inline-block rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 hover:underline">{n} +</Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <div className="min-w-0 overflow-x-auto md:col-span-2">
              <table className="min-w-full text-sm">
                <thead className="border-b border-ink-100 text-left text-xs uppercase text-ink-500">
                  <tr><th className="py-2 pr-3">Ingredient</th><th className="py-2 pr-3 text-right">Needed</th><th className="py-2 pr-3 text-right">In stock</th><th className="py-2 text-right">Short</th></tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {plan.ingredients.map((i) => (
                    <tr key={i.item_id} className={Number(i.short) > 0 ? 'bg-red-50/60' : ''}>
                      <td className="py-2 pr-3 font-medium">{i.item}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{formatQtySmart(i.qty, i.unit)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{formatQty(i.stock, i.unit)}</td>
                      <td className="py-2 text-right tabular-nums">{Number(i.short) > 0 ? <strong className="text-red-700">{formatQtySmart(i.short, i.unit)}</strong> : '—'}</td>
                    </tr>
                  ))}
                  {plan.ingredients.length === 0 && <tr><td colSpan={4} className="py-6 text-center text-ink-500">No ingredients: no orders or no recipes for this meal.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Card>

      <div className="print:hidden">
        <RecipeEditor kitchenId={kitchen.kitchenId} isOwner={isOwner} dishes={dishes} items={items ?? []} initialNewDish={newDish} />
      </div>
    </>
  );
}
