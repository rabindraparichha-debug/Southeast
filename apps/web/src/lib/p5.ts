// Shapes of the P5/P6 jsonb results (supabase/migrations/20261105000100_p5.sql, 20261106000100_p6.sql)
// plus small display helpers shared by the dashboard, admin, print and customer pages.
import type { DietType, MealSlot, SlotTotals } from '@tiffin/db';

/** private.slot_totals since P5/P6: veg-day switches and meals per health tag. */
export type SlotTotalsP5 = SlotTotals & { veg_switched?: number; by_health?: Record<string, number> };

export const HEALTH_TAGS = ['diabetic', 'low_salt', 'low_oil', 'low_spice', 'no_onion_garlic', 'soft_food'] as const;
export type HealthTag = (typeof HEALTH_TAGS)[number];
export const HEALTH_TAG_LABEL: Record<string, string> = {
  diabetic: 'Diabetic',
  low_salt: 'Low salt',
  low_oil: 'Low oil',
  low_spice: 'Low spice',
  no_onion_garlic: 'No onion/garlic',
  soft_food: 'Soft food',
};
export const healthLabel = (t: string) => HEALTH_TAG_LABEL[t] ?? t.replace(/_/g, ' ');

export type FestivalSpecial = {
  id: string;
  service_date: string;
  slot: MealSlot;
  name: string;
  description: string | null;
  /** null for staff (money is owner-only) or when there is no add-on price. */
  addon_price_paise: number | null;
  notified: number;
  festival: string | null;
};

export type StickerEater = { name: string; qty: number; diet: DietType; veg_day: boolean; health_tags: string[] };
export type StickerStop = {
  stop_id: string;
  run_id: string;
  route_name: string;
  seq: number;
  name: string;
  office: boolean;
  line1: string | null;
  landmark: string | null;
  area: string | null;
  meal_count: number;
  diets: Record<string, number> | null;
  veg_day: boolean;
  health_tags: string[];
  eaters: StickerEater[] | null;
  notes: string | null;
  qr_token: string;
  status: 'pending' | 'delivered' | 'failed';
};

export type Office = {
  id: string;
  name: string;
  line1: string | null;
  area: string | null;
  landmark: string | null;
  lat: number | null;
  lng: number | null;
  contact_name: string | null;
  /** Full number for the owner, masked for staff. */
  contact_phone: string | null;
  /** Owner only. */
  billing_customer_id: string | null;
  billing_customer_name: string | null;
  active: boolean;
  members: number;
};

export type OfficeStatement = {
  office: { id: string; name: string; billing_customer_id: string; billing_customer_name: string | null };
  month: string;
  members: { customer_id: string; name: string; meals: number; amount_paise: number; credit_meals: number; paid_paise: number; balance_meals: number }[];
  totals: { meals: number; amount_paise: number; paid_paise: number; balance_meals: number };
};

export type WeatherAlert = {
  service_date: string;
  slot: MealSlot;
  kind: 'rain' | 'heat' | 'rain_heat';
  detail: Record<string, unknown>;
  customers_notified: number;
  created_at: string;
};
export const WEATHER_LABEL = { rain: 'Heavy rain', heat: 'Heat', rain_heat: 'Rain and heat' } as const;

export type Referral = {
  id: string;
  referrer_customer_id: string;
  referrer_name: string;
  referee_customer_id: string;
  referee_name: string;
  code: string;
  source: 'vendor' | 'lead' | 'portal';
  status: 'pending' | 'rewarded' | 'no_reward';
  reward_meals: number;
  rewarded_at: string | null;
  created_at: string;
};
export const REFERRAL_STATUS = {
  pending: { label: 'Waiting for first payment', tone: 'blue' },
  rewarded: { label: 'Rewarded', tone: 'green' },
  no_reward: { label: 'No reward (off)', tone: 'gray' },
} as const;

export type VendorScore = {
  kitchen_id: string;
  days: number;
  complaints: number;
  delivered_meals: number;
  complaints_per_100_meals: number | null;
  median_first_response_minutes: number | null;
  unanswered: number;
  escalated: number;
  by_category: Record<string, number>;
  kitchen_name?: string;
  status?: string;
};

export type CustomerScore = {
  customer_id: string;
  days: number;
  complaints: number;
  meals: number;
  complaints_per_100_meals: number | null;
  first_complaint_credited: boolean;
};

export type CommissionStatement = {
  commission_bps: number | null;
  commission_paise: number;
  rows: { payment_id: string; customer_name: string; amount_paise: number; commission_paise: number; transfer_paise: number; created_at: string }[];
};

export const RISK_LABEL: Record<string, string> = {
  balance_out: 'Balance finished, no payment for 3 days',
  skips: '3+ skips in the last week',
  open_complaint: 'Open complaint',
  paused_long: 'Paused for over a week',
  trial_not_converted: 'Trial not converted',
};

/** Basis points → "2.5%". */
export const bpsLabel = (bps: number | null | undefined) => `${((bps ?? 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}%`;

/** "TFN:ABCD…", a URL ending in the code, or the bare code all read as the code (same as private.scan_token). */
export function scanToken(input: string | null | undefined): string | null {
  const s = String(input ?? '').replace(/^.*[:/=]/, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return s || null;
}

/** "2026-11-08" → "Sun 8 Nov". */
export function shortDate(d: string): string {
  return new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}
