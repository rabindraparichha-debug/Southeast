import type { Database } from '@tiffin/db';

// Inventory (M6) helpers shared by the web pages. Quantities are stored in the item's unit;
// the RPCs accept another unit of the same kind (kg↔g, l↔ml) and convert.

export type StockUnit = Database['public']['Enums']['stock_unit'];
export type ItemCategory = Database['public']['Enums']['item_category'];

export const UNITS: StockUnit[] = ['kg', 'g', 'l', 'ml', 'pc'];
export const UNIT_LABEL: Record<StockUnit, string> = { kg: 'kg', g: 'g', l: 'litre', ml: 'ml', pc: 'piece' };

export const CATEGORIES: ItemCategory[] = ['grain', 'pulse', 'vegetable', 'dairy', 'meat', 'spice', 'oil', 'gas', 'packaging', 'other'];
export const CATEGORY_LABEL: Record<ItemCategory, string> = {
  grain: 'Grain', pulse: 'Pulse', vegetable: 'Vegetable', dairy: 'Dairy', meat: 'Meat / fish', spice: 'Spice',
  oil: 'Oil', gas: 'Gas', packaging: 'Packaging', other: 'Other',
};

/** Units a quantity of this item can be entered in (its own unit first). */
export function unitsFor(unit: StockUnit): StockUnit[] {
  switch (unit) {
    case 'kg': return ['kg', 'g'];
    case 'g': return ['g', 'kg'];
    case 'l': return ['l', 'ml'];
    case 'ml': return ['ml', 'l'];
    default: return ['pc'];
  }
}

const qtyFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 });

/** 6.46, 'kg' -> "6.46 kg" */
export function formatQty(qty: number | string | null | undefined, unit: StockUnit): string {
  if (qty === null || qty === undefined || qty === '') return '—';
  return `${qtyFmt.format(Number(qty))} ${unit}`;
}

/** Small quantities in the smaller unit: 0.03 kg -> "30 g", 1.5 kg -> "1.5 kg". */
export function formatQtySmart(qty: number | string, unit: StockUnit): string {
  const n = Number(qty);
  if (unit === 'kg' && Math.abs(n) < 1 && n !== 0) return `${qtyFmt.format(Math.round(n * 1000 * 10) / 10)} g`;
  if (unit === 'l' && Math.abs(n) < 1 && n !== 0) return `${qtyFmt.format(Math.round(n * 1000 * 10) / 10)} ml`;
  return formatQty(n, unit);
}

/** Signed variance: +0.5 kg / −1 kg */
export function formatSignedQty(qty: number | null | undefined, unit: StockUnit): string {
  if (qty === null || qty === undefined) return '—';
  const n = Number(qty);
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${qtyFmt.format(Math.abs(n))} ${unit}`;
}

/** "1.5" -> 1.5; null when not a number. allowNegative for adjustments. */
export function parseQty(input: string, { allowNegative = false, allowZero = false } = {}): number | null {
  const s = input.trim().replace(/,/g, '');
  if (!/^[-+]?\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (n < 0 && !allowNegative) return null;
  if (n === 0 && !allowZero) return null;
  return n;
}

/** "Wed, 28 Oct" for a YYYY-MM-DD date */
export function formatDay(date: string): string {
  return new Date(`${date.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** A timestamptz shown as an IST date + time */
export function formatIstDateTime(at: string): string {
  return new Date(at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

// --- Shapes of the jsonb RPC results (see supabase/migrations/20261102000100_inventory.sql) ---

export type InventoryAlert =
  | { type: 'low_stock'; item_id: string; item: string; unit: StockUnit; stock: number; min_qty: number }
  | { type: 'price_jump'; item_id: string; item: string; unit: StockUnit; pct: number; bill_date: string; unit_price_paise: number | null }
  | { type: 'variance'; item_id: string; item: string; unit: StockUnit; variance: number; pct: number; reason: string | null; date: string };

export type DishCost = {
  dish_id: string;
  name: string;
  serves: Database['public']['Enums']['diet_type'][];
  active: boolean;
  cost_per_portion_paise: number | null;
  lines: { item_id: string; item: string; unit: StockUnit; qty_per_portion: number; cost_paise: number | null }[];
};

export type ProductionPlan = {
  dishes: { dish_id: string; name: string; portions: number }[];
  ingredients: { item_id: string; item: string; unit: StockUnit; qty: number; stock: number; short: number }[];
  no_recipe: string[];
  consumed: boolean;
};

export type StockTakeLine = {
  item_id: string;
  item: string;
  unit: StockUnit;
  expected: number;
  counted: number | null;
  variance: number | null;
  variance_value_paise: number | null;
  variance_pct: number | null;
  reason: string | null;
  needs_reason: boolean;
};

export type StockTakeReview = { id: string; status: 'open' | 'closed'; started_at: string; closed_at: string | null; lines: StockTakeLine[] };

export type PriceJump = { item: string; pct: number; from_paise?: number; to_paise?: number };
export type PurchaseResult = { purchase_id: string; total_paise: number; price_jumps: PriceJump[] };

/**
 * record_purchase returns one object per price jump: {item, pct} plus {from_paise, to_paise} for owners.
 * Tolerates the shape where the owner-only prices arrive as a separate array element (and staff get
 * an empty {}), which `array || obj || obj` produces in SQL.
 */
export function normalizePriceJumps(raw: unknown): PriceJump[] {
  const out: PriceJump[] = [];
  for (const el of Array.isArray(raw) ? raw : []) {
    if (!el || typeof el !== 'object') continue;
    const o = el as Partial<PriceJump>;
    if (typeof o.item === 'string') out.push({ item: o.item, pct: Number(o.pct), from_paise: o.from_paise, to_paise: o.to_paise });
    else if (out.length && o.from_paise != null) Object.assign(out[out.length - 1]!, { from_paise: o.from_paise, to_paise: o.to_paise });
  }
  return out;
}

export type CostReport = {
  from: string;
  to: string;
  meals: number;
  revenue_paise: number;
  ingredients_paise: number;
  waste_paise: number;
  stock_loss_paise: number;
  gas_paise: number;
  packaging_paise: number;
  total_cost_paise: number;
  cost_per_meal_paise: number | null;
  revenue_per_meal_paise: number | null;
  margin_per_meal_paise: number | null;
  margin_pct: number | null;
  by_day: { date: string; meals: number; ingredients_paise: number }[];
};

const UNIT_FACTOR: Record<StockUnit, number> = { kg: 1000, g: 1, l: 1000, ml: 1, pc: 1 };

/** Same conversion as private.convert_qty (only between compatible units: kg↔g, l↔ml). */
export function convertQty(qty: number, from: StockUnit, to: StockUnit): number {
  if (from === to) return qty;
  return (qty * UNIT_FACTOR[from]) / UNIT_FACTOR[to];
}
