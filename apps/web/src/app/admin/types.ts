import type { KitchenStatus } from '@tiffin/db';

// Shapes of the admin RPCs' jsonb results (supabase/migrations/20261103000100_admin_hardening.sql,
// 20261101000100_acquisition.sql). Postgres numerics arrive as numbers; nullable ones say so.

export type PlatformMetrics = {
  kitchens: { total: number; active: number; draft: number; suspended: number; goal_live: number };
  customers: { total: number; on_whatsapp: number; whatsapp_pct: number | null; platform_sourced: number; platform_paid: number };
  subscriptions: { live: number; trial: number; autopay: number };
  last_7_days: {
    meals: number; collections_paise: number; whatsapp_changes: number; all_changes: number;
    stops: number; stops_proved: number; leads: number; vendor_applications: number;
  };
  open: { escalated_complaints: number; vendor_applications: number; waitlisted_leads: number; outbox_failed: number };
};

export type AdminKitchen = {
  id: string; name: string; slug: string; area: string | null; status: KitchenStatus; fssai_no: string | null;
  kyc_status: string | null; linked_account: boolean | null;
  customers: number; whatsapp_pct: number | null; platform_customers: number; live_subscriptions: number; meals_7d: number;
  last_lock: string | null; checklist_done: number; checklist_total: number; open_complaints: number; created_at: string;
};

export type AuditRow = {
  id: number; at: string; kitchen: string | null; actor_id: string | null; actor_phone_last4: string | null; actor_role: string | null;
  table: string; row_id: string | null; action: 'INSERT' | 'UPDATE' | 'DELETE' | 'ACCESS';
  before: Record<string, unknown> | null; after: Record<string, unknown> | null;
};

export type AdminReview = {
  id: string; kitchen: string; kitchen_slug: string; rating: number; comment: string | null; customer: string | null;
  verified: boolean; hidden: boolean; created_at: string;
};

/** A percentage with one decimal, or null when the denominator is 0. */
export function share(n: number, d: number): number | null {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : null;
}

/** public.engine_health() (supabase/migrations/20261110000100_engine_health.sql). */
export type EngineJob = {
  job: string; critical: boolean; max_age_minutes: number; scheduled: boolean; active: boolean; schedule: string | null;
  last_ok_at: string | null; last_duration_ms: number | null; last_result: Record<string, unknown> | null; stale: boolean; healthy: boolean;
};
export type EngineHealth = {
  ok: boolean;
  checked_at: string;
  jobs: EngineJob[];
  overdue_slots: { count: number; items: { kitchen_id: string; kitchen: string; service_date: string; slot: 'lunch' | 'dinner'; cutoff_at: string }[] };
  /** Latest failed run per tiffin-* job not cleared since; only critical ones affect `ok`. */
  cron: { failing: { job: string; at: string; critical: boolean; message: string }[]; failures_24h: number };
  /** Wave 1's engine_errors: open rows; `recent` = open rows seen within `window_hours` (these affect `ok`). */
  engine_errors: {
    tracked: boolean; window_hours: number; open: number; recent: number; by_job: Record<string, number>;
    items: {
      id: number; kitchen_id: string | null; kitchen: string | null; job: string; service_date: string | null;
      slot: 'lunch' | 'dinner' | null; message: string; attempts: number; first_seen_at: string; last_seen_at: string;
    }[];
  };
};
