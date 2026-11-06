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
  /** Wave 1: a kitchen closure covers this meal (kitchen_closures). */
  closed?: boolean;
  closure_reason?: string | null;
  /** Wave 1: cutoff passed 5+ minutes ago and the slot is still not locked. */
  overdue?: boolean;
  /** Wave 1: the open lock or run-building error for this slot (engine_errors), if any. */
  engine_error?: string | null;
};

/** public.request_schedule_change result (preview or confirmed). */
export type ChangeResult = {
  dry_run: boolean;
  change_id?: string;
  after_cutoff: boolean;
  from_date: string;
  to_date: string | null;
  /** charged: the customer pays for it (late and not waived); credited: "don't charge" credit posted (D-116). */
  affected: { date: string; slot: MealSlot; late: boolean; charged: boolean; credited?: boolean; order_id?: string }[];
  /** revoke_schedule_change only: the skip or pause that was undone. */
  revoked_change_id?: string;
};

/** public.subscription_holds row: an upcoming skip or pause (with Undo). */
export type SubscriptionHold = Database['public']['Functions']['subscription_holds']['Returns'][number];

/** public.reactivate_subscription result. */
export type ReactivateResult = { subscription_id: string; status: SubscriptionStatus; from_date: string };

/** public.set_kitchen_closure / remove_kitchen_closure result. */
export type ClosureResult = { dry_run: boolean; closure_id?: string; service_date: string; slot: MealSlot | null; orders: number; meals: number };

/** public.sync_rejects row: a rider action the server refused, for the owner (D-128). */
export type SyncReject = Database['public']['Functions']['sync_rejects']['Returns'][number];
