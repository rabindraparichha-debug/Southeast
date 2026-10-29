// Store UTC, display IST, define cutoffs in IST. India has no DST, so IST is a fixed +05:30.

export const IST_OFFSET_MINUTES = 330;
export type Slot = 'lunch' | 'dinner';

/** Today's date in IST as YYYY-MM-DD. */
export function istDate(at: Date = new Date()): string {
  return new Date(at.getTime() + IST_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
}

/** Adds days to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** ISO day of week (1 = Monday … 7 = Sunday) for a YYYY-MM-DD date. */
export function isoDow(date: string): number {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return dow === 0 ? 7 : dow;
}

/**
 * The UTC instant when changes close for a meal.
 * cutoff "21:00" + prevDay true for service date 2026-11-03 -> 2026-11-02 21:00 IST.
 */
export function cutoffInstant(serviceDate: string, cutoffTime: string, prevDay: boolean): Date {
  const day = prevDay ? addDays(serviceDate, -1) : serviceDate;
  const [h = '0', m = '0'] = cutoffTime.split(':');
  const utcMs = Date.parse(`${day}T${h.padStart(2, '0')}:${m.padStart(2, '0')}:00Z`);
  return new Date(utcMs - IST_OFFSET_MINUTES * 60_000);
}

/** "21:00:00" -> "9:00 pm" */
export function formatTime12h(time: string): string {
  const [hs = '0', ms = '0'] = time.split(':');
  const h = Number(hs);
  const suffix = h >= 12 ? 'pm' : 'am';
  return `${h % 12 === 0 ? 12 : h % 12}:${ms.padStart(2, '0')} ${suffix}`;
}

export const WEEKDAYS: { iso: number; short: string; long: string }[] = [
  { iso: 1, short: 'Mon', long: 'Monday' },
  { iso: 2, short: 'Tue', long: 'Tuesday' },
  { iso: 3, short: 'Wed', long: 'Wednesday' },
  { iso: 4, short: 'Thu', long: 'Thursday' },
  { iso: 5, short: 'Fri', long: 'Friday' },
  { iso: 6, short: 'Sat', long: 'Saturday' },
  { iso: 7, short: 'Sun', long: 'Sunday' },
];

export const SLOT_LABEL: Record<Slot, string> = { lunch: 'Lunch', dinner: 'Dinner' };

/** "2026-11-03" -> "Tue, 3 Nov" */
export function formatServiceDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** A timestamptz -> "Mon 9:00 pm" in IST. */
export function formatIstShort(at: string | Date): string {
  return new Date(at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', hour: 'numeric', minute: '2-digit' });
}
