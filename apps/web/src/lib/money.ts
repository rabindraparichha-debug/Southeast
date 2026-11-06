import { formatPaise, SLOT_LABEL } from '@tiffin/core';
import type { BillingMode, MealSlot } from '@tiffin/db';

// Shared shapes and wording for the wave-2 money screens (D-115: billing mode per customer).
// Monthly (pay later): the balance is in rupees (Σ amount_paise); prepaid: in meals.

export const BILLING_LABEL: Record<BillingMode, string> = { monthly: 'Monthly (pay later)', prepaid: 'Prepaid' };
export const BILLING_SHORT: Record<BillingMode, string> = { monthly: 'Monthly', prepaid: 'Prepaid' };
export const BILLING_TONE = { monthly: 'blue', prepaid: 'gray' } as const;

/** "owes ₹1,200", "₹300 advance", "settled" (monthly) or "owes 3 meals", "12 meals" (prepaid). */
export function balanceText(mode: BillingMode, meals: number, paise: number): string {
  if (mode === 'monthly') {
    if (paise < 0) return `owes ${formatPaise(-paise)}`;
    if (paise > 0) return `${formatPaise(paise)} advance`;
    return 'settled';
  }
  if (meals < 0) return `owes ${-meals} meal${meals === -1 ? '' : 's'}`;
  return `${meals} meal${meals === 1 ? '' : 's'}`;
}

/** True when the customer owes money (monthly) or meals (prepaid). */
export const owes = (mode: BillingMode, meals: number, paise: number) => (mode === 'monthly' ? paise < 0 : meals < 0);

/** A full Indian number the vendor can open in WhatsApp (accountants and staff get masked numbers). */
export const isFullPhone = (phone: string | null | undefined): phone is string => /^\+91\d{10}$/.test(phone ?? '');

/** A fresh idempotency key for one save (a retry or double tap reuses it, the server keeps one row). */
export function newClientOp(): string {
  return crypto.randomUUID();
}

/** The payment time for a backdated entry: noon IST on that day (undefined = now, for today). */
export function paidAtFor(date: string, today: string): string | undefined {
  return date && date !== today ? `${date}T12:00:00+05:30` : undefined;
}

/** "2026-11" or any date in it -> "2026-11-01". */
export const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
/** "2026-11-01" -> "November 2026". */
export const monthLabel = (d: string) =>
  new Date(`${d.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
/** Month arithmetic on "YYYY-MM-01". */
export function addMonths(d: string, n: number): string {
  const [y, m] = d.slice(0, 7).split('-').map(Number) as [number, number];
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  return t.toISOString().slice(0, 10);
}
/** Valid "YYYY-MM" query value. */
export const isMonth = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

/** Saves server-made text (CSV) as a file in the browser. */
export function downloadText(name: string, text: string, type = 'text/csv;charset=utf-8') {
  // Excel needs the BOM to read UTF-8 (₹, Odia names).
  const url = URL.createObjectURL(new Blob(['﻿' + text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// public.customer_statement
export type StatementLine = {
  entry_id: string;
  at: string;
  date: string;
  type: 'meal' | 'recharge' | 'credit' | 'refund' | 'adjust';
  ref_type: string | null;
  meals: number;
  amount_paise: number;
  service_date: string | null;
  slot: MealSlot | null;
  qty: number | null;
  price_per_meal_paise: number | null;
  method: string | null;
  note: string | null;
  balance_meals: number;
  balance_paise: number;
};
export type CustomerStatement = {
  customer: { id: string; name: string; billing_mode: BillingMode; phone: string | null; kitchen_id: string };
  kitchen_name: string;
  month: string;
  from: string;
  to: string;
  opening: { meals: number; paise: number };
  totals: {
    meals_charged: number; charged_paise: number; paid_paise: number; credit_meals: number; credit_paise: number;
    refund_paise: number; voided_paise: number; adjust_paise: number; net_meals: number; net_paise: number;
  };
  closing: { meals: number; paise: number };
  amount_due_paise: number;
  lines: StatementLine[];
};

// public.monthly_bills
export type MonthlyBill = {
  customer_id: string; name: string; billing_mode: BillingMode; opening_paise: number; meals: number;
  charged_paise: number; paid_paise: number; credit_paise: number; refund_paise: number; adjust_paise: number;
  closing_paise: number; closing_meals: number; amount_due_paise: number | null;
};
export type MonthlyBills = { month: string; bills: MonthlyBill[] };

const METHOD: Record<string, string> = {
  cash: 'cash', upi_manual: 'UPI', bank_transfer: 'bank transfer', razorpay_link: 'online', razorpay_autopay: 'autopay',
};

/** One statement row in words. */
export function statementLineLabel(l: StatementLine): string {
  switch (l.type) {
    case 'meal':
      // The date column already shows the service date.
      return `${l.slot ? SLOT_LABEL[l.slot] : 'Meal'}${l.qty && l.qty > 1 ? ` ×${l.qty}${l.price_per_meal_paise ? ` · ${formatPaise(l.price_per_meal_paise)} each` : ''}` : ''}`;
    case 'recharge':
      return `Payment${l.method ? ` (${METHOD[l.method] ?? l.method})` : ''}`;
    case 'credit':
      return l.note || 'Free meal';
    case 'refund':
      return l.note || 'Refund';
    default:
      return l.ref_type === 'payment_void' ? `Payment voided${l.note ? ` · ${l.note.replace(/^Payment voided:\s*/, '')}` : ''}` : l.note || 'Adjustment';
  }
}

// public.change_requests_list
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
