// Generated types live in ./types.ts (run `pnpm db:types` after every migration).
export type { Database, Json, Tables, TablesInsert, TablesUpdate, Enums } from './types';
import type { Database } from './types';

type PublicViews = Database['public']['Views'];
export type View<T extends keyof PublicViews> = PublicViews[T]['Row'];

export type MemberRole = Database['public']['Enums']['member_role'];
export type MealSlot = Database['public']['Enums']['meal_slot'];
export type DietType = Database['public']['Enums']['diet_type'];
export type LanguageCode = Database['public']['Enums']['language_code'];
export type SubscriptionStatus = Database['public']['Enums']['subscription_status'];
export type KitchenStatus = Database['public']['Enums']['kitchen_status'];

export type ImportResult = {
  batch_id: string;
  total: number;
  imported: number;
  failed: number;
  errors: { row: number; errors: string[] }[];
};

export type OrderStatus = Database['public']['Enums']['order_status'];
export type ChangeType = Database['public']['Enums']['change_type'];

/** Totals for one slot (private.slot_totals). */
export type SlotTotals = {
  total_meals: number;
  orders: number;
  to_deliver: number;
  skipped: number;
  late_skips: number;
  by_diet: Record<DietType, number>;
  by_plan: { plan: string; meals: number }[];
  by_area: { area: string; meals: number }[];
};

/** public.slot_summary result. */
export type SlotSummary = {
  service_date: string;
  slot: MealSlot;
  cutoff_at: string;
  weekly_off: boolean;
  locked: boolean;
  locked_at: string | null;
  locked_totals: SlotTotals | null;
  live: SlotTotals;
};

/** public.request_schedule_change result (preview or confirmed). */
export type ChangeResult = {
  dry_run: boolean;
  change_id?: string;
  after_cutoff: boolean;
  from_date: string;
  to_date: string | null;
  affected: { date: string; slot: MealSlot; late: boolean; charged: boolean }[];
};
