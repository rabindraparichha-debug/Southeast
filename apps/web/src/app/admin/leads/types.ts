import type { DietType, MealSlot } from '@tiffin/db';
import type { LeadSource, LeadStatus, ShortlistKitchen } from '@/lib/public';

export type AdminLeadRow = {
  id: string;
  name: string | null;
  phone: string;
  source: LeadSource;
  campaign: string | null;
  status: LeadStatus;
  area: string | null;
  slots: MealSlot[] | null;
  diet: DietType | null;
  budget_per_meal_paise: number | null;
  start_date: string | null;
  whatsapp_opt_in: boolean;
  chosen_kitchen: string | null;
  matches: number;
  created_at: string;
  updated_at: string;
  notes: string | null;
  lost_reason: string | null;
};

export type NearbyKitchen = { kitchen_id: string; name: string; status: string; distance_km: number; radius_km: number };

export type AdminLeadDetail = AdminLeadRow & {
  language: string;
  address_text: string | null;
  lat: number | null;
  lng: number | null;
  consent_at: string | null;
  bot_step: string | null;
  chosen_kitchen_id: string | null;
  customer_id: string | null;
  qualified_at: string | null;
  matched_at: string | null;
  trial_at: string | null;
  converted_at: string | null;
  renewed_at: string | null;
  kitchens: ShortlistKitchen[];
  events: { event: string; detail: Record<string, unknown>; at: string }[];
  nearby: NearbyKitchen[];
};
