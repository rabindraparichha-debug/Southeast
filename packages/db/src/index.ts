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
