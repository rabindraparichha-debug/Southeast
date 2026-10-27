import { notFound } from 'next/navigation';
import { formatPaise, formatPhone } from '@tiffin/core';
import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { Badge, Card, DIET_LABEL, DIET_TONE, LANGUAGE_LABEL, PageHeader, STATUS_LABEL, STATUS_TONE } from '@/components/ui';
import { AddressManager } from './address-manager';
import { EditCustomer } from './edit-customer';
import { AddSubscription } from './add-subscription';
import { EraseCustomer } from './erase-customer';

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

  const [{ data: subscriptions }, { data: plans }, { data: k }] = isOwner
    ? await Promise.all([
        supabase.from('subscriptions').select('id, status, qty, start_date, end_date, plan:plans(name, slots, price_per_meal_paise)').eq('customer_id', id).order('created_at', { ascending: false }),
        supabase.from('plans').select('id, name, price_per_meal_paise, slots, diet').eq('kitchen_id', kitchen.kitchenId).eq('active', true).order('name'),
        supabase.from('kitchens').select('lat, lng').eq('id', kitchen.kitchenId).single(),
      ])
    : [{ data: null }, { data: null }, { data: null }];

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
                </li>
              ))}
              {subscriptions?.length === 0 && <li className="py-3 text-sm text-ink-500">No subscriptions yet.</li>}
            </ul>
            <AddSubscription kitchenId={kitchen.kitchenId} customerId={c.id!} diet={c.diet!} plans={plans ?? []} addresses={addresses ?? []} />
            <p className="mt-3 text-xs text-ink-500">Pause, skip, cancel and balances arrive with the daily engine and money milestones.</p>
          </Card>
        )}

        {isOwner && <EraseCustomer customerId={c.id!} />}
      </div>
    </>
  );
}
