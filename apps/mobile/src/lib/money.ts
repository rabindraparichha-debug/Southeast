import { SLOT_LABEL, addDays, formatPaise, formatServiceDate } from '@tiffin/core';
import type { BillingMode, MealSlot, PaymentStatus } from '@tiffin/db';
import { friendlyError } from './errors';
import { t } from '@/i18n';

// Shared shapes and wording for the wave-2 money screens (D-115: billing mode per customer).
// Monthly (pay later): the balance is in rupees (Σ amount_paise); prepaid: in meals.
// Mirrors apps/web/src/lib/money.ts.

export const billingLabel = (mode: BillingMode) => t(`billing.${mode}`);

/** "Owes ₹1,200", "₹300 advance", "Settled" (monthly) or "Owes 3 meals", "12 meals" (prepaid). */
export function balanceText(mode: BillingMode, meals: number, paise: number): string {
  if (mode === 'monthly') {
    if (paise < 0) return t('money.owesRupees', { amount: formatPaise(-paise) });
    if (paise > 0) return t('money.advance', { amount: formatPaise(paise) });
    return t('money.settled');
  }
  if (meals < 0) return t('money.owes', { n: -meals });
  return t('balance.meals', { n: meals });
}

/** True when the customer owes money (monthly) or meals (prepaid). */
export const owes = (mode: BillingMode, meals: number, paise: number) => (mode === 'monthly' ? paise < 0 : meals < 0);

/** A full Indian number (owners and managers); staff and accountants get masked numbers. */
export const isFullPhone = (phone: string | null | undefined): phone is string => /^\+91\d{10}$/.test(phone ?? '');

/**
 * A fresh idempotency key for one save. Keep it while the form is open: a retry or double tap
 * sends the same key and the server keeps one row (record_payment, record_purchase, record_waste,
 * rider_request_change). Math.random is fine for idempotency keys.
 */
export function newClientOp(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** supabase-js reports a dropped connection as an error without a Postgres code. */
export function isOfflineError(e: { message?: string; code?: string } | null | undefined): boolean {
  if (!e || (e.code && e.code !== '')) return false;
  return /network|fetch|timed? ?out|abort|connection/i.test(e.message ?? '');
}

/** Error text, with the screen's own wording for a reused idempotency key. */
export function friendlyErrorFor(
  error: { message?: string; code?: string } | null | undefined,
  context: 'payment' | 'stock' | 'rider_request',
): string {
  if (error?.message === 'invalid_client_op') return t(`errors.invalid_client_op.${context}`);
  if (isOfflineError(error)) return t('money.offline');
  return friendlyError(error);
}

/** The payment time for a backdated entry: noon IST on that day (undefined = now, for today). */
export function paidAtFor(date: string, today: string): string | undefined {
  return date && date !== today ? `${date}T12:00:00+05:30` : undefined;
}

/** "2026-11-06" -> "2026-11-01". */
export const monthStart = (d: string) => `${d.slice(0, 7)}-01`;

/** "2026-11-01" -> "November 2026". */
export const monthLabel = (d: string) =>
  new Date(`${d.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Today and the n-1 days before it, newest first (backdating chips). */
export const recentDays = (today: string, n: number) => Array.from({ length: n }, (_, i) => addDays(today, -i));

/** Cash, UPI, bank: the methods a vendor records by hand. */
export const MANUAL_METHODS = ['cash', 'upi_manual', 'bank_transfer'] as const;
export type ManualMethod = (typeof MANUAL_METHODS)[number];
export const methodLabel = (method: string) => t(`method.${method}`);

export type PaymentRow = {
  id: string;
  method: string;
  status: PaymentStatus;
  amount_paise: number;
  meals: number;
  paid_at: string | null;
  created_at: string;
  note: string | null;
  void_reason: string | null;
  collected_by: string | null;
};

// public.customer_statement (only the parts the app shows)
export type StatementSummary = {
  month: string;
  opening: { meals: number; paise: number };
  totals: {
    meals_charged: number; charged_paise: number; paid_paise: number; credit_paise: number;
    refund_paise: number; voided_paise: number; adjust_paise: number;
  };
  closing: { meals: number; paise: number };
  amount_due_paise: number;
};

// public.change_requests_list
/** p_status for every status (the parameter defaults to 'pending'; SQL null means all). */
export const ALL_STATUSES = null as unknown as string;
export type ChangeRequestRow = {
  id: string;
  type: 'skip' | 'pause' | 'resume' | 'cancel' | 'address';
  from_date: string;
  to_date: string | null;
  slot: MealSlot | null;
  note: string | null;
  status: 'pending' | 'approved' | 'rejected';
  requested_at: string;
  decided_at: string | null;
  decision_note: string | null;
  customer_id: string;
  customer_name: string;
  subscription_id: string | null;
  plan_name: string | null;
  stop_id: string | null;
  change_id: string | null;
  requested_by: string;
  requested_by_name: string | null;
};

/** "Tue, 3 Nov – Fri, 6 Nov · Lunch only" in words. */
export function requestDates(r: Pick<ChangeRequestRow, 'type' | 'from_date' | 'to_date' | 'slot'>): string {
  const slot = r.slot ? ` · ${t('requests.slotOnly', { slot: SLOT_LABEL[r.slot] })}` : '';
  if (r.type === 'cancel') return t('requests.cancelFrom', { date: formatServiceDate(r.from_date) });
  if (r.type === 'resume' || r.type === 'address') return `${t('requests.from', { date: formatServiceDate(r.from_date) })}${slot}`;
  if (!r.to_date) return `${t('requests.openEnded', { date: formatServiceDate(r.from_date) })}${slot}`;
  if (r.to_date === r.from_date) return `${formatServiceDate(r.from_date)}${slot}`;
  return `${formatServiceDate(r.from_date)} – ${formatServiceDate(r.to_date)}${slot}`;
}
