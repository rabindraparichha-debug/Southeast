import { Platform } from 'react-native';
import { File } from 'expo-file-system';
import type { Database } from '@tiffin/db';

// Inventory (M6) helpers for the quick-entry screens. Quantities are stored in the item's unit;
// the RPCs accept a compatible unit (kg↔g, l↔ml) and convert, so the UI only offers those.

export type StockUnit = Database['public']['Enums']['stock_unit'];
export type StockRow = Database['public']['Functions']['stock_levels']['Returns'][number];

export type InventoryAlert =
  | { type: 'low_stock'; item_id: string; item: string; unit: StockUnit; stock: number; min_qty: number }
  | { type: 'price_jump'; item_id: string; item: string; unit: StockUnit; pct: number; bill_date: string; unit_price_paise: number | null }
  | { type: 'variance'; item_id: string; item: string; unit: StockUnit; variance: number; pct: number; reason: string | null; date: string };

export type PriceJump = { item: string; from_paise: number; to_paise: number; pct: number };
export type PurchaseResult = { purchase_id: string; total_paise: number; price_jumps: PriceJump[] };

export type CountResult = { item_id: string; expected: number; counted: number | null; variance: number | null; needs_reason: boolean };
export type ReviewLine = {
  item_id: string; item: string; unit: StockUnit; expected: number; counted: number | null; variance: number | null;
  variance_pct: number | null; reason: string | null; needs_reason: boolean;
};
export type StockTakeReview = { id: string; status: 'open' | 'closed'; started_at: string; closed_at: string | null; lines: ReviewLine[] };

const SAME_KIND: Record<StockUnit, StockUnit[]> = { kg: ['kg', 'g'], g: ['g', 'kg'], l: ['l', 'ml'], ml: ['ml', 'l'], pc: ['pc'] };

/** Units a quantity of this item can be entered in (the item's own unit first). */
export function unitsFor(unit: StockUnit): StockUnit[] {
  return SAME_KIND[unit];
}

const FACTOR: Record<StockUnit, number> = { kg: 1000, g: 1, l: 1000, ml: 1, pc: 1 };

/** Same conversion as private.convert_qty (only between compatible units). */
export function convertQty(qty: number, from: StockUnit, to: StockUnit): number {
  if (from === to) return qty;
  return (qty * FACTOR[from]) / FACTOR[to];
}

/** "1.5", "0,5", "500" -> number; null if empty or not a non-negative number (max 3 decimals). */
export function parseQty(input: string): number | null {
  const s = input.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,3})?$|^\.\d{1,3}$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 6.46 -> "6.46", 2 -> "2", 0.0005 -> "0" (3 decimals at most, no trailing zeros). */
export function formatQty(qty: number | string | null | undefined): string {
  const n = Number(qty ?? 0);
  if (!Number.isFinite(n)) return '—';
  const r = Math.round(n * 1000) / 1000;
  return String(Object.is(r, -0) ? 0 : r);
}

/** Signed quantity with unit for variances: "+0.5 kg", "−1 kg". */
export function formatVariance(qty: number, unit: StockUnit): string {
  const r = Math.round(qty * 1000) / 1000;
  if (r === 0) return `0 ${unit}`;
  return `${r > 0 ? '+' : '−'}${formatQty(Math.abs(r))} ${unit}`;
}

/** Bytes of a picked photo (native file URI, or a blob/data URL on web). */
export async function readPhotoBytes(uri: string): Promise<ArrayBuffer> {
  if (Platform.OS === 'web') return (await fetch(uri)).arrayBuffer();
  return new File(uri).arrayBuffer();
}
