import type { ReactNode } from 'react';
import Link from 'next/link';
import { addDays, cutoffInstant, formatIstShort, formatPhone, istDate, isoDow } from '@tiffin/core';
import type { MealSlot, SubscriptionStatus } from '@tiffin/db';
import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { findCustomers } from '@/lib/customer-search';
import { loadHolds } from '@/lib/holds';
import { coveringHolds, opensSingleMatch } from '@/lib/desk-rules';
import { Card, PageHeader } from '@/components/ui';
import { DeskPanel, type DeskCell, type DeskSub } from './desk-panel';

// Phone desk (audit item 28): the owner on the phone with a customer. One search box, the caller's
// next 7 days by meal, and Skip / Pause / Undo / Resume in two taps, always previewed first.
// No payments here (the customer page has the money panel).

const DAYS = 7;

type Meal = {
  id: string; subscription_id: string; service_date: string; slot: MealSlot; qty: number; status: string;
  charged: boolean; charge_waived: boolean; skip_reason: string | null; locked_at: string | null; stop_id: string | null;
};
type KitchenRules = {
  cutoff_lunch: string; cutoff_lunch_prev_day: boolean; cutoff_dinner: string; cutoff_dinner_prev_day: boolean;
  weekly_off: number[]; weekly_off_lunch: number[]; weekly_off_dinner: number[];
};

function cellFor(meal: Meal | undefined, opts: {
  closed: boolean; weeklyOff: boolean; cutoff: Date; now: Date; holdIds: string[]; stopPending: boolean;
}): Omit<DeskCell, 'slot'> {
  const passed = opts.now >= opts.cutoff;
  const base = { qty: meal?.qty ?? 0, holdIds: [] as string[], until: null as string | null,
    frozen: Boolean(meal?.locked_at) || passed, changeable: false };
  if (!meal) {
    if (opts.closed) return { ...base, state: 'closed' };
    if (opts.weeklyOff) return { ...base, state: 'weekly_off' };
    return { ...base, state: 'none' };
  }
  if (meal.status === 'skipped') {
    if (meal.charged) return { ...base, state: meal.charge_waived ? 'late_waived' : 'late_charged' };
    return { ...base, state: meal.skip_reason === 'pause' ? 'paused' : 'skipped', holdIds: opts.holdIds };
  }
  // Out with the rider: a skip still reaches it while the stop is pending (D-121, like the customer page).
  if (meal.status === 'out') return { ...base, state: 'on_way', changeable: opts.stopPending };
  if (meal.status === 'delivered') return { ...base, state: 'delivered' };
  if (meal.status === 'failed') return { ...base, state: 'failed' };
  if (meal.locked_at || passed || meal.status !== 'scheduled') return { ...base, state: 'locked', changeable: true };
  return { ...base, state: 'open', changeable: true, until: formatIstShort(opts.cutoff) };
}

export default async function DeskPage({ searchParams }: PageProps<'/desk'>) {
  const { kitchen } = await requireKitchen(['owner']);
  const sp = await searchParams;
  const q = String(sp.q ?? '').trim();
  const supabase = await createClient();

  const found = q
    ? await findCustomers(supabase, { kitchenId: kitchen.kitchenId, q, isOwner: true, status: 'all', page: 1, pageSize: 20 })
    : { rows: [], total: 0, page: 1, error: null };
  // A lone match opens by itself only for a name/address or a full number: bare digits may be a flat
  // or a phone ending, so the owner picks from the list.
  const selectedId = typeof sp.c === 'string' ? sp.c : found.rows.length === 1 && opensSingleMatch(q) ? found.rows[0]!.id : null;

  let panel: ReactNode = null;
  if (selectedId) {
    const today = istDate();
    const last = addDays(today, DAYS - 1);
    const [{ data: c }, { data: subs }, { data: meals }, { data: k }, { data: closures }, holds] = await Promise.all([
      supabase.from('customers_v').select('id, name, phone, line1, landmark, area, delivery_notes')
        .eq('id', selectedId).eq('kitchen_id', kitchen.kitchenId).maybeSingle(),
      supabase.from('subscriptions').select('id, status, qty, start_date, end_date, plan:plans(name, slots)')
        .eq('customer_id', selectedId).order('created_at'),
      supabase.from('meal_orders')
        .select('id, subscription_id, service_date, slot, qty, status, charged, charge_waived, skip_reason, locked_at, stop_id')
        .eq('customer_id', selectedId).gte('service_date', today).lte('service_date', last),
      supabase.from('kitchens')
        .select('cutoff_lunch, cutoff_lunch_prev_day, cutoff_dinner, cutoff_dinner_prev_day, weekly_off, weekly_off_lunch, weekly_off_dinner')
        .eq('id', kitchen.kitchenId).single(),
      supabase.from('kitchen_closures').select('closed_on, slot').eq('kitchen_id', kitchen.kitchenId)
        .gte('closed_on', today).lte('closed_on', last),
      loadHolds(supabase, selectedId, true),
    ]);
    // Meals out with the rider can still be skipped while their stop is pending.
    const outStops = ((meals ?? []) as Meal[]).filter((m) => m.status === 'out' && m.stop_id).map((m) => m.stop_id!);
    const { data: stops } = outStops.length
      ? await supabase.from('delivery_stops').select('id, status').in('id', outStops)
      : { data: [] as { id: string; status: string }[] };
    const pendingStops = new Set((stops ?? []).filter((x) => x.status === 'pending').map((x) => x.id));
    if (c) {
      const rules = k as KitchenRules | null;
      const now = new Date();
      const live = (subs ?? []).filter((s) => s.status !== 'cancelled');
      const deskSubs: DeskSub[] = live.map((s) => {
        const slots = ((s.plan?.slots ?? ['lunch']) as MealSlot[]).slice().sort((a, b) => (a === b ? 0 : a === 'lunch' ? -1 : 1));
        return {
          id: s.id,
          planName: s.plan?.name ?? 'Plan',
          status: s.status as SubscriptionStatus,
          qty: s.qty,
          slots,
          days: Array.from({ length: DAYS }, (_, i) => {
            const date = addDays(today, i);
            const dow = isoDow(date);
            return {
              date,
              cells: slots.map((slot) => {
                const meal = (meals as Meal[] | null)?.find((m) => m.subscription_id === s.id && m.service_date === date && m.slot === slot);
                const cutoff = rules
                  ? cutoffInstant(date, slot === 'lunch' ? rules.cutoff_lunch : rules.cutoff_dinner,
                      slot === 'lunch' ? rules.cutoff_lunch_prev_day : rules.cutoff_dinner_prev_day)
                  : now;
                return {
                  slot,
                  ...cellFor(meal, {
                    closed: (closures ?? []).some((x) => x.closed_on === date && (!x.slot || x.slot === slot)),
                    weeklyOff: Boolean(rules && (rules.weekly_off.includes(dow) || (slot === 'lunch' ? rules.weekly_off_lunch : rules.weekly_off_dinner).includes(dow))),
                    cutoff,
                    now,
                    holdIds: meal?.status === 'skipped' ? coveringHolds(holds, s.id, date, slot).map((h) => h.change_id) : [],
                    stopPending: Boolean(meal?.stop_id && pendingStops.has(meal.stop_id)),
                  }),
                };
              }),
            };
          }),
        };
      });
      panel = (
        <DeskPanel
          key={c.id}
          today={today}
          customer={{
            id: c.id!, name: c.name!, phone: formatPhone(c.phone),
            address: [c.line1, c.landmark, c.area].filter(Boolean).join(', '), notes: c.delivery_notes,
          }}
          subs={deskSubs}
          cancelled={(subs ?? []).length - live.length}
          holds={holds}
        />
      );
    } else {
      panel = <Card><p className="text-sm text-ink-500">This customer was not found.</p></Card>;
    }
  }

  const back = q ? `/desk?q=${encodeURIComponent(q)}` : '/desk';
  return (
    <>
      <PageHeader title="Phone desk" subtitle="Find the caller, see their week, then skip, pause, undo or resume in two taps." />
      <form className="mb-4 flex max-w-xl gap-2" action="/desk">
        <input
          name="q"
          defaultValue={q}
          type="search"
          autoFocus={!selectedId}
          placeholder="Name, flat, area, landmark, full phone or last 4 digits"
          aria-label="Search customers"
          className="w-full rounded-lg border-0 px-3 py-2 text-sm ring-1 ring-ink-200 focus:ring-2 focus:ring-brand-500"
        />
        <button type="submit" className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">Find</button>
      </form>
      <div className="grid gap-6 lg:grid-cols-3">
        {q && (
          <Card title={`Results (${found.total})`} className={selectedId && sp.c ? 'hidden lg:block' : ''}>
            {found.error && <p className="text-sm text-red-700">{found.error}</p>}
            <ul className="divide-y divide-ink-100" data-testid="desk-results">
              {found.rows.map((r) => (
                <li key={r.id}>
                  <Link
                    href={`/desk?q=${encodeURIComponent(q)}&c=${r.id}`}
                    className={`block rounded-lg px-2 py-2 text-sm hover:bg-ink-50 ${r.id === selectedId ? 'bg-brand-50' : ''}`}
                  >
                    <span className="block font-medium text-ink-900">{r.name}</span>
                    <span className="block text-xs text-ink-500">
                      {[[r.line1, r.area].filter(Boolean).join(', '), formatPhone(r.phone)].filter(Boolean).join(' · ') || 'No address'}
                    </span>
                  </Link>
                </li>
              ))}
              {found.rows.length === 0 && !found.error && <li className="py-2 text-sm text-ink-500">No customers match.</li>}
            </ul>
            {found.total > found.rows.length && (
              <p className="mt-2 text-xs text-ink-500">Showing {found.rows.length} of {found.total}. Type more of the name or flat.</p>
            )}
          </Card>
        )}
        <div className={q ? 'min-w-0 lg:col-span-2' : 'min-w-0 lg:col-span-3'}>
          {selectedId && sp.c && q && (
            <Link href={back} className="mb-3 inline-block text-sm font-medium text-brand-700 lg:hidden">← Back to results</Link>
          )}
          {panel ?? (
            !q && (
              <Card>
                <p className="text-sm text-ink-600">
                  Type the caller’s name, flat, area or landmark, or the last 4 digits of their number (the full number works too).
                  Their next {DAYS} days appear here: tap a meal to skip it, pause from it, undo a skip or resume.
                </p>
              </Card>
            )
          )}
        </div>
      </div>
    </>
  );
}
