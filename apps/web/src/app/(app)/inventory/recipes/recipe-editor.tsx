'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { formatPaise } from '@tiffin/core';
import type { DietType } from '@tiffin/db';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError, friendlyErrorIn } from '@/lib/errors';
import { UNIT_LABEL, formatQtySmart, parseQty, unitsFor, type DishCost, type StockUnit } from '@/lib/inventory';
import { Alert, Badge, Button, Card, DIET_LABEL, Input, Select } from '@/components/ui';

type Item = { id: string; name: string; unit: StockUnit };
const DIETS: DietType[] = ['veg', 'nonveg', 'jain'];

export function RecipeEditor({ kitchenId, isOwner, dishes, items, initialNewDish }: {
  kitchenId: string; isOwner: boolean; dishes: DishCost[]; items: Item[]; initialNewDish: string;
}) {
  const [showInactive, setShowInactive] = useState(false);
  const shown = dishes.filter((d) => showInactive || d.active);
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-ink-900">Dishes ({dishes.filter((d) => d.active).length})</h2>
        <label className="flex items-center gap-2 text-sm text-ink-600">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive
        </label>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {shown.map((d) => <DishCard key={d.dish_id} kitchenId={kitchenId} isOwner={isOwner} dish={d} items={items} />)}
        <NewDish key={initialNewDish} kitchenId={kitchenId} initialName={initialNewDish} />
      </div>
    </div>
  );
}

function ServesPicker({ value, onChange, disabled }: { value: DietType[]; onChange: (v: DietType[]) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap gap-3 text-sm">
      {DIETS.map((d) => (
        <label key={d} className="flex items-center gap-1.5">
          <input type="checkbox" disabled={disabled} checked={value.includes(d)}
            onChange={(e) => onChange(e.target.checked ? DIETS.filter((x) => x === d || value.includes(x)) : value.filter((x) => x !== d))} />
          {DIET_LABEL[d]}
        </label>
      ))}
    </div>
  );
}

function DishCard({ kitchenId, isOwner, dish, items }: { kitchenId: string; isOwner: boolean; dish: DishCost; items: Item[] }) {
  const router = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [itemId, setItemId] = useState('');
  const [qty, setQty] = useState('');
  const [unit, setUnit] = useState<StockUnit | ''>('');
  const item = items.find((i) => i.id === itemId);
  // Recipes are usually written in grams / ml per portion.
  const defaultUnit: StockUnit | '' = item ? (item.unit === 'kg' ? 'g' : item.unit === 'l' ? 'ml' : item.unit) : '';
  const effectiveUnit = unit || defaultUnit;

  async function run(p: PromiseLike<{ error: { message?: string; code?: string } | null }>, ctx?: 'dish') {
    setBusy(true);
    setError('');
    const { error } = await p;
    setBusy(false);
    if (error) {
      setError(ctx ? friendlyErrorIn(ctx, error) : friendlyError(error));
      return false;
    }
    router.refresh();
    return true;
  }

  const s = supabaseBrowser();
  const saveDish = (patch: { serves?: DietType[]; active?: boolean }) => {
    if (patch.serves && patch.serves.length === 0) return setError('A dish must serve at least one diet.');
    void run(s.rpc('upsert_dish', { p_kitchen: kitchenId, p_dish: dish.dish_id, p_name: dish.name, p_serves: patch.serves ?? dish.serves, p_active: patch.active ?? dish.active }), 'dish');
  };

  async function addLine(e: FormEvent) {
    e.preventDefault();
    if (!item) return setError('Choose an ingredient.');
    const n = parseQty(qty);
    if (n === null) return setError('Enter the quantity per portion, like 30 (g).');
    const ok = await run(s.rpc('set_recipe_line', { p_dish: dish.dish_id, p_item: item.id, p_qty: n, p_unit: (effectiveUnit || item.unit) as StockUnit }));
    if (ok) {
      setItemId('');
      setQty('');
      setUnit('');
    }
  }

  return (
    <Card
      title={<span>{dish.name} {!dish.active && <Badge>Inactive</Badge>}</span>}
      actions={isOwner && dish.cost_per_portion_paise != null && (
        <span className="text-sm text-ink-600" data-testid="cost-per-portion">{formatPaise(Number(dish.cost_per_portion_paise))} / portion</span>
      )}
    >
      <div data-dish={dish.name} className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <ServesPicker value={dish.serves} onChange={(serves) => saveDish({ serves })} disabled={busy} />
          <label className="flex items-center gap-1.5 text-sm text-ink-600">
            <input type="checkbox" checked={dish.active} disabled={busy} onChange={(e) => saveDish({ active: e.target.checked })} /> Active
          </label>
        </div>
        <table className="min-w-full text-sm">
          <tbody className="divide-y divide-ink-100">
            {dish.lines.map((l) => (
              <tr key={l.item_id}>
                <td className="py-1.5 pr-3">{l.item}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{formatQtySmart(l.qty_per_portion, l.unit)}</td>
                {isOwner && <td className="py-1.5 pr-3 text-right tabular-nums text-ink-500">{l.cost_paise != null ? formatPaise(Number(l.cost_paise)) : ''}</td>}
                <td className="py-1.5 text-right">
                  <button type="button" disabled={busy} className="text-xs text-ink-400 hover:text-red-700" aria-label={`Remove ${l.item}`}
                    onClick={() => void run(s.rpc('set_recipe_line', { p_dish: dish.dish_id, p_item: l.item_id, p_qty: 0 }))}>Remove</button>
                </td>
              </tr>
            ))}
            {dish.lines.length === 0 && <tr><td className="py-2 text-ink-500">No ingredients yet.</td></tr>}
          </tbody>
        </table>
        <form onSubmit={addLine} className="flex flex-wrap gap-1.5" aria-label={`Add ingredient to ${dish.name}`}>
          <Select value={itemId} onChange={(e) => { setItemId(e.target.value); setUnit(''); }} className="min-w-36 flex-1" aria-label="Ingredient">
            <option value="">Ingredient…</option>
            {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </Select>
          <Input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" placeholder="per portion" className="w-24!" aria-label="Quantity per portion" />
          <Select value={effectiveUnit}
            onChange={(e) => setUnit(e.target.value as StockUnit)} className="w-24!" disabled={!item} aria-label="Unit">
            {item ? unitsFor(item.unit).map((u) => <option key={u} value={u}>{UNIT_LABEL[u]}</option>) : <option value="">unit</option>}
          </Select>
          <Button variant="secondary" disabled={busy}>Add</Button>
        </form>
        <p className="text-xs text-ink-500">Adding an ingredient that is already in the recipe changes its quantity.</p>
        {error && <Alert>{error}</Alert>}
      </div>
    </Card>
  );
}

function NewDish({ kitchenId, initialName }: { kitchenId: string; initialName: string }) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [serves, setServes] = useState<DietType[]>(DIETS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!name.trim()) return setError('Enter the dish name as it appears on the menu.');
    if (serves.length === 0) return setError('A dish must serve at least one diet.');
    setBusy(true);
    const { error } = await supabaseBrowser().rpc('upsert_dish', { p_kitchen: kitchenId, p_name: name.trim(), p_serves: serves });
    setBusy(false);
    if (error) return setError(friendlyErrorIn('dish', error));
    setName('');
    setServes(DIETS);
    router.refresh();
  }

  return (
    <Card title={<span id="new-dish">New dish</span>}>
      <form onSubmit={save} className="space-y-3" aria-label="New dish">
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Name, exactly as on the menu (e.g. Dalma)" aria-label="Dish name" />
        <div>
          <div className="mb-1 text-sm font-medium text-ink-700">Served to</div>
          <ServesPicker value={serves} onChange={setServes} />
        </div>
        <p className="text-xs text-ink-500">Menu dishes are matched to recipes by name. Portions are counted from the orders of the diets this dish serves.</p>
        {error && <Alert>{error}</Alert>}
        <Button disabled={busy}>Add dish</Button>
      </form>
    </Card>
  );
}
