// Shapes returned by the M5 delivery RPCs (jsonb results are untyped in the generated types),
// plus small display helpers shared by the /delivery pages.
import { IST_OFFSET_MINUTES, addDays, istDate, isIsoDate } from '@tiffin/core';
import type { MealSlot, MemberRole } from '@tiffin/db';

export type RunStatus = 'planned' | 'out' | 'done';
export type StopStatus = 'pending' | 'delivered' | 'failed';
export type ProofType = 'otp' | 'photo' | 'none';

export type BoardStop = {
  id: string;
  seq: number;
  customer_id: string;
  customer_name: string;
  line1: string | null;
  area: string | null;
  landmark: string | null;
  lat: number | null;
  lng: number | null;
  meal_count: number;
  status: StopStatus;
  proof_type: ProofType | null;
  otp_ok: boolean | null;
  photo_path: string | null;
  done_at: string | null;
  offline: boolean;
  synced_at: string | null;
  failed_reason: string | null;
  failed_note: string | null;
  kitchen_fault: boolean | null;
  gps_distance_m: number | null;
  tiffins_out: number;
  tiffins_returned: number;
  /** Owner only; null for staff. */
  cash_paise: number | null;
};

export type BoardRun = {
  id: string;
  route_id: string;
  route_name: string;
  rider_id: string | null;
  rider_name: string | null;
  status: RunStatus;
  started_at: string | null;
  finished_at: string | null;
  planned_km: number | null;
  last_lat: number | null;
  last_lng: number | null;
  last_seen_at: string | null;
  counts: { stops: number; meals: number; delivered: number; failed: number; pending: number; proved: number };
  stops: BoardStop[];
};

export type BoardRider = { user_id: string; name: string | null; role: MemberRole };

export type LiveBoard = {
  service_date: string;
  slot: MealSlot;
  locked: boolean;
  kitchen: { lat: number | null; lng: number | null; name: string } | null;
  unassigned: number;
  riders: BoardRider[];
  routes: { id: string; name: string; rider_id: string | null; active: boolean; stops: number }[];
  runs: BoardRun[];
};

export type RoutePoint = {
  address_id: string;
  seq: number;
  pinned: boolean;
  customer_name: string;
  area: string | null;
  landmark: string | null;
  lat: number | null;
  lng: number | null;
};

export type RoutePoints = {
  route_id: string;
  name: string;
  slot: MealSlot;
  kitchen: { lat: number | null; lng: number | null } | null;
  stops: RoutePoint[];
};

export type OptimizeResult = { km_before: number; km_after: number; engine: 'vroom' | 'local' | string };

export const FAIL_REASON_LABEL: Record<string, string> = {
  not_home: 'Not at home',
  wrong_address: 'Wrong address',
  refused: 'Refused',
  unreachable: 'Could not reach',
  kitchen_late: 'Kitchen late',
  food_issue: 'Food issue',
  missing_meal: 'Meal missing',
  rider_issue: 'Rider issue',
  other: 'Other',
};

export const RUN_STATUS_LABEL: Record<RunStatus, string> = { planned: 'Planned', out: 'Out for delivery', done: 'Done' };
export const RUN_STATUS_TONE = { planned: 'blue', out: 'amber', done: 'green' } as const;

/** GPS more than this far from the saved pin is flagged for review. */
export const GPS_WARN_M = 300;

export const isDate = isIsoDate;

/**
 * The slot the delivery board opens on: the one being delivered now or next, by the IST clock.
 * Lunch until 4 pm, dinner until 10 pm, then tomorrow's lunch (already locked by then).
 */
export function currentDeliverySlot(at: Date = new Date()): { date: string; slot: MealSlot } {
  const ist = new Date(at.getTime() + IST_OFFSET_MINUTES * 60_000);
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const today = istDate(at);
  if (minutes < 16 * 60) return { date: today, slot: 'lunch' };
  if (minutes < 22 * 60) return { date: today, slot: 'dinner' };
  return { date: addDays(today, 1), slot: 'lunch' };
}

/** A timestamptz -> "9:05 pm" in IST. */
export function formatIstTime(at: string | Date): string {
  return new Date(at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });
}

/** A timestamptz -> "29 Oct, 9:05 pm" in IST. */
export function formatIstDateTime(at: string | Date): string {
  return new Date(at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

export function formatKm(km: number | null | undefined): string {
  return km == null ? '—' : `${Number(km).toFixed(1)} km`;
}
