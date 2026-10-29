import { notFound } from 'next/navigation';
import { SLOT_LABEL, addDays, formatPaise, formatPhone, formatServiceDate, istDate } from '@tiffin/core';
import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { Badge, Card, DIET_LABEL, DIET_TONE, LANGUAGE_LABEL, PageHeader, STATUS_LABEL, STATUS_TONE } from '@/components/ui';
import { AddressManager } from './address-manager';
import { EditCustomer } from './edit-customer';
import { AddSubscription } from './add-subscription';
import { EraseCustomer } from './erase-customer';
import { SubscriptionActions } from './subscription-actions';

const formatDate = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export default async function CustomerPage({ params }: PageProps<'/customers/[id]'>) {
  const { id } = await params;
  const { kitchen } = await requireKitchen(['owner', 'staff']);
  const supabase = await createClient();
  const { data: c } = await supabase.from('customers_v').select('*').eq('id', id).eq('kitchen_id', kitchen.kitchenId).maybeSingle();
  if (!c) notFound();
  const isOwner = kitchen.role === 'owner';

  const { data: addresses } = await supabase
    .from('addresses')
    .select('id, label, line1, area, landmark, delivery_notes, lat, lng, is_default')
    .eq('customer_id', id)
    .order('is_default', { ascending: false });

  const today = istDate();
  const { data: meals } = await supabase
    .from('meal_orders')
    .select('id, subscription_id, service_date, slot, qty, status, charged, skip_reason, locked_at')
    .eq('customer_id', id)
    .gte('service_date', addDays(today, -3))
    .lte('service_date', addDays(today, 7))
    .order('service_date')
    .order('slot');

  const [{ data: subscriptions }, { data: plans }, { data: k }, { data: balance }, { data: entries }, { data: settings }] = isOwner
    ? await Promise.all([
        supabase.from('subscriptions').select('id, status, qty, start_date, end_date, plan:plans(name, slots, price_per_meal_paise)').eq('customer_id', id).order('created_at', { ascending: false }),
        supabase.from('plans').select('id, name, price_per_meal_paise, slots, diet').eq('kitchen_id', kitchen.kitchenId).eq('active', true).order('name'),
        supabase.from('kitchens').select('lat, lng').eq('id', kitchen.kitchenId).single(),
        supabase.from('customer_balances').select('meals, amount_paise').eq('customer_id', id).maybeSingle(),
        supabase.from('balance_entries').select('id, type, meals, amount_paise, note, created_at, ref_id').eq('customer_id', id).order('created_at', { ascending: false }).limit(8),
        supabase.from('kitchen_settings').select('notice_days').eq('kitchen_id', kitchen.kitchenId).single(),
      ])
    : [{ data: null }, { data: null }, { data: null }, { data: null }, { data: null }, { data: null }];

  return (
    <>
      <PageHeader
        title={c.name!}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span>{formatPhone(c.phone)}</span>
            {c.diet && <Badge tone={DIET_TONE[c.diet]}>{DIET_LABEL[c.diet]}</Badge>}
            {c.preferred_language && <Badge>{LANGUAGE_LABEL[c.preferred_language]}</Badge>}
            {c.platform_sourced && <Badge tone="blue">Platform customer</Badge>}
          </span>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        {isOwner ? (
          <EditCustomer customer={{ id: c.id!, name: c.name!, phone: c.phone ?? '', diet: c.diet!, preferred_language: c.preferred_language!, notes: c.notes ?? '' }} />
        ) : (
          <Card title="Details">
            <p className="text-sm text-ink-600">{c.notes || 'No notes.'}</p>
          </Card>
        )}

        <AddressManager
          kitchenId={kitchen.kitchenId}
          customerId={c.id!}
          addresses={addresses ?? []}
          editable={isOwner}
          center={k?.lat && k?.lng ? { lat: k.lat, lng: k.lng } : null}
        />

        <Card title="Meals" className="lg:col-span-2">
          {meals && meals.length > 0 ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
              {meals.map((m) => {
                const tone =
                  m.status === 'skipped'
                    ? m.charged ? 'bg-amber-50 ring-amber-200' : 'bg-ink-50 ring-ink-200 text-ink-500'
                    : m.service_date < today ? 'bg-white ring-ink-100 text-ink-500' : 'bg-green-50 ring-green-200';
                return (
                  <div key={m.id} className={`rounded-lg px-3 py-2 text-xs ring-1 ${tone}`}>
                    <div className="font-medium">{formatServiceDate(m.service_date)}</div>
                    <div>
                      {SLOT_LABEL[m.slot]}{m.qty > 1 ? ` ×${m.qty}` : ''} ·{' '}
                      {m.status === 'skipped'
                        ? m.charged ? 'Late skip (charged)' : m.skip_reason === 'pause' ? 'Paused' : 'Skipped'
                        : m.locked_at ? 'Locked' : 'Scheduled'}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-ink-500">No meals in the last 3 or next 7 days.</p>
          )}
        </Card>

        {isOwner && (
          <Card title="Meal balance">
            <div className="text-3xl font-semibold">{balance?.meals ?? 0} <span className="text-base font-normal text-ink-500">meals</span></div>
            <p className="text-sm text-ink-500">{formatPaise(balance?.amount_paise ?? 0)} prepaid value</p>
            <ul className="mt-4 divide-y divide-ink-100 text-sm">
              {(entries ?? []).map((e) => (
                <li key={e.id} className="flex justify-between gap-3 py-1.5">
                  <span>
                    {e.type === 'meal' ? 'Meal' : e.note ?? e.type}{' '}
                    <span className="text-ink-500">
                      {(() => {
                        const m = e.type === 'meal' ? meals?.find((x) => x.id === e.ref_id) : undefined;
                        return m
                          ? `${formatServiceDate(m.service_date)} ${SLOT_LABEL[m.slot]}`
                          : new Date(e.created_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' });
                      })()}
                    </span>
                  </span>
                  <span className={e.meals < 0 ? 'text-ink-700' : 'text-green-700'}>{e.meals > 0 ? '+' : ''}{e.meals}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-ink-500">Recharges, cash entry and refunds arrive in the money milestone.</p>
          </Card>
        )}

        {isOwner && (
          <Card title="Subscriptions" className="lg:col-span-2">
            <ul className="mb-4 divide-y divide-ink-100">
              {(subscriptions ?? []).map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                  <div>
                    <div className="font-medium">
                      {s.plan?.name} {s.qty > 1 && <span className="text-ink-500">× {s.qty} tiffins</span>}
                    </div>
                    <div className="text-ink-500">
                      From {formatDate(s.start_date)}
                      {s.end_date && ` to ${formatDate(s.end_date)}`} · {s.plan && formatPaise(s.plan.price_per_meal_paise)} per meal
                    </div>
                  </div>
                  <Badge tone={STATUS_TONE[s.status]}>{STATUS_LABEL[s.status]}</Badge>
                  {s.status !== 'cancelled' && s.status !== 'trial' && (
                    <div className="w-full">
                      <SubscriptionActions
                        subscriptionId={s.id}
                        slots={s.plan?.slots ?? ['lunch']}
                        addresses={(addresses ?? []).map((a) => ({ id: a.id, label: a.label || [a.line1, a.area].filter(Boolean).join(', ') || 'Address' }))}
                        nextMeal={(meals ?? []).find((m) => m.subscription_id === s.id && m.status === 'scheduled' && !m.locked_at) ?? null}
                        today={today}
                        noticeDays={settings?.notice_days ?? 1}
                      />
                    </div>
                  )}
                </li>
              ))}
              {subscriptions?.length === 0 && <li className="py-3 text-sm text-ink-500">No subscriptions yet.</li>}
            </ul>
            <AddSubscription kitchenId={kitchen.kitchenId} customerId={c.id!} diet={c.diet!} plans={plans ?? []} addresses={addresses ?? []} />
            <p className="mt-3 text-xs text-ink-500">Trial subscriptions start getting meals once they become active (payments milestone).</p>
          </Card>
        )}

        {isOwner && <EraseCustomer customerId={c.id!} />}
      </div>
    </>
  );
}
