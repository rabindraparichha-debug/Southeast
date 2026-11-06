import 'server-only';
import type { DietType, LanguageCode, SubscriptionStatus } from '@tiffin/db';
import type { createClient } from './supabase/server';

// Customer search with paging, the real total and status filters, shared by the customer list and
// the phone desk. Reads customers_v (security_invoker: RLS and the phone masking apply as usual).
// * text: name, flat (line1), area or landmark of the default address;
// * 1-4 digits: the end of the phone number (phone_last4);
// * a full phone number: search_customers (phone hash; owners only, as before).
// Status filters need subscriptions, which only owners can read (RLS), so staff get none.

type Client = Awaited<ReturnType<typeof createClient>>;

export const STATUS_FILTERS = [
  ['all', 'All'],
  ['active', 'Active'],
  ['paused', 'Paused'],
  ['low_balance', 'Low balance'],
  ['suspended', 'Suspended'],
  ['trial', 'Trial'],
  ['no_plan', 'No live plan'],
] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number][0];

export const parseStatus = (v: unknown): StatusFilter =>
  STATUS_FILTERS.some(([k]) => k === v) ? (v as StatusFilter) : 'all';

export type CustomerRow = {
  id: string;
  name: string;
  phone: string | null;
  phone_last4: string | null;
  platform_sourced: boolean;
  line1: string | null;
  landmark: string | null;
  area: string | null;
  diet: DietType;
  preferred_language: LanguageCode;
  /** Owners only: statuses of the customer's subscriptions (null for staff). */
  statuses: SubscriptionStatus[] | null;
};

/** page: the page actually shown (a page past the end shows the last one). */
export type CustomerPage = { rows: CustomerRow[]; total: number; page: number; error: string | null };

const COLUMNS = 'id, name, phone, phone_last4, platform_sourced, line1, landmark, area, diet, preferred_language';
const SEARCH_CLEAN = /[,()*%"\\:]/g;

const isFullPhone = (q: string) => {
  const digits = q.replace(/\D/g, '');
  return digits.length >= 10 && digits === q.replace(/[\s+\-]/g, '');
};

type Raw = Omit<CustomerRow, 'statuses'> & { subs?: { status: SubscriptionStatus }[] };

const toRow = (r: Raw, isOwner: boolean): CustomerRow => {
  const { subs, ...rest } = r;
  return { ...rest, statuses: isOwner ? (subs ?? []).map((s) => s.status) : null };
};

/** The status a filter matches, for rows that came back without a database-side filter. */
function matches(row: CustomerRow, status: StatusFilter) {
  if (status === 'all' || !row.statuses) return true;
  if (status === 'no_plan') return !row.statuses.some((s) => s !== 'cancelled');
  return row.statuses.includes(status);
}

export async function findCustomers(supabase: Client, opts: {
  kitchenId: string; q: string; isOwner: boolean; status: StatusFilter; page: number; pageSize: number;
}): Promise<CustomerPage> {
  const q = opts.q.trim();
  const status = opts.isOwner ? opts.status : 'all';
  const from = Math.max(0, opts.page - 1) * opts.pageSize;

  // Full phone number: only the hash lookup can find it (owners; nobody else may search by number).
  if (q && isFullPhone(q)) {
    if (!opts.isOwner) return { rows: [], total: 0, page: 1, error: null };
    const { data, error } = await supabase.rpc('search_customers', { p_kitchen: opts.kitchenId, p_q: q, p_limit: 200 });
    if (error) return { rows: [], total: 0, page: 1, error: error.message };
    const ids = (data ?? []).map((c) => c.id);
    const { data: subs } = ids.length
      ? await supabase.from('subscriptions').select('customer_id, status').in('customer_id', ids)
      : { data: [] as { customer_id: string; status: SubscriptionStatus }[] };
    const rows = (data ?? [])
      .map((c) => toRow({ ...(c as unknown as Raw), subs: (subs ?? []).filter((s) => s.customer_id === c.id) }, true))
      .filter((r) => matches(r, status));
    const page = Math.min(Math.max(1, opts.page), Math.max(1, Math.ceil(rows.length / opts.pageSize)));
    const start = (page - 1) * opts.pageSize;
    return { rows: rows.slice(start, start + opts.pageSize), total: rows.length, page, error: null };
  }

  let select = COLUMNS;
  if (opts.isOwner) select += ', subs:subscriptions(status)';
  if (status === 'no_plan') select += ', live:subscriptions(id)';
  else if (status !== 'all') select += ', f:subscriptions!inner(status)';

  let query = supabase.from('customers_v').select(select as '*', { count: 'exact' }).eq('kitchen_id', opts.kitchenId);
  if (/^\d{1,4}$/.test(q)) {
    query = query.like('phone_last4', `%${q}`);
  } else if (q) {
    const term = q.replace(SEARCH_CLEAN, ' ').replace(/\s+/g, ' ').trim();
    if (term) query = query.or(['name', 'line1', 'area', 'landmark'].map((c) => `${c}.ilike.*${term}*`).join(','));
  }
  if (status === 'no_plan') query = query.filter('live.status', 'neq', 'cancelled').filter('live', 'is', null);
  else if (status !== 'all') query = query.filter('f.status', 'eq', status);

  const { data, count, error } = await query.order('name').order('id').range(from, from + opts.pageSize - 1);
  if (error?.code === 'PGRST103' && opts.page > 1) {
    // A page past the end (the list shrank, or an edited URL): show the last page instead.
    const total = Number(/only (\d+) rows/.exec(error.details ?? '')?.[1] ?? 0);
    return findCustomers(supabase, { ...opts, page: Math.max(1, Math.ceil(total / opts.pageSize)) });
  }
  if (error) return { rows: [], total: 0, page: opts.page, error: error.message };
  return { rows: ((data ?? []) as unknown as Raw[]).map((r) => toRow(r, opts.isOwner)), total: count ?? 0, page: opts.page, error: null };
}

/** Badge text and tone for a customer's subscriptions (owner view). */
export function statusSummary(statuses: SubscriptionStatus[]): SubscriptionStatus | 'none' {
  const order: SubscriptionStatus[] = ['active', 'low_balance', 'suspended', 'paused', 'trial', 'cancelled'];
  return order.find((s) => statuses.includes(s)) ?? 'none';
}
