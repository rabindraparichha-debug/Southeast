import Link from 'next/link';
import { SLOT_LABEL, addDays, formatPaise, istDate } from '@tiffin/core';
import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { friendlyError } from '@/lib/errors';
import { shortDate, type FestivalSpecial } from '@/lib/p5';
import { Alert, Badge, Card, PageHeader } from '@/components/ui';
import { SpecialForm, DeleteSpecial } from './special-form';

// Festival specials (P5): a special dish for a date and meal, announced to the kitchen's customers.
// Owner creates and deletes; staff see the list (without the add-on price, which is money).
export default async function SpecialsPage() {
  const { kitchen } = await requireKitchen(['owner', 'staff']);
  const isOwner = kitchen.role === 'owner';
  const supabase = await createClient();
  const today = istDate();
  const [{ data, error }, { data: festivals }] = await Promise.all([
    supabase.rpc('festival_specials_list', { p_kitchen: kitchen.kitchenId, p_from: today, p_to: addDays(today, 90) }),
    supabase.from('food_calendar').select('id, kind, name, starts_on, ends_on, veg_only').gte('ends_on', today).lte('starts_on', addDays(today, 60)).order('starts_on'),
  ]);
  const specials = (data ?? []) as unknown as FestivalSpecial[];

  return (
    <>
      <PageHeader title="Festival specials" subtitle="Special dishes for festivals and occasions. Customers see them on their page."
        actions={<Link href="/menu" className="rounded-lg px-3 py-2 text-sm ring-1 ring-ink-200 hover:bg-ink-50">← Menu</Link>} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={`Coming up (${specials.length})`}>
          {error && <Alert>{friendlyError(error)}</Alert>}
          <ul className="divide-y divide-ink-100 text-sm" data-testid="specials-list">
            {specials.map((s) => (
              <li key={s.id} className="flex flex-wrap items-start justify-between gap-2 py-3">
                <div className="min-w-0">
                  <div className="font-medium">{s.name}</div>
                  <div className="text-ink-500">
                    {shortDate(s.service_date)} · {SLOT_LABEL[s.slot]}
                    {s.festival && <> · {s.festival}</>}
                    {isOwner && s.addon_price_paise != null && <> · +{formatPaise(s.addon_price_paise)}</>}
                  </div>
                  {s.description && <p className="text-ink-600">{s.description}</p>}
                  {s.notified > 0 && <p className="text-xs text-ink-500">Told {s.notified} customer{s.notified === 1 ? '' : 's'} on WhatsApp</p>}
                </div>
                {isOwner && <DeleteSpecial id={s.id} />}
              </li>
            ))}
            {!specials.length && !error && <li className="py-3 text-ink-500">No specials planned.</li>}
          </ul>
        </Card>

        <div className="space-y-6">
          {isOwner && <SpecialForm kitchenId={kitchen.kitchenId} today={today} festivals={festivals ?? []} />}
          <Card title="Festival calendar">
            <ul className="space-y-1.5 text-sm">
              {(festivals ?? []).map((f) => (
                <li key={f.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>{f.name}</span>
                  <span className="flex items-center gap-1.5 text-ink-500">
                    {shortDate(f.starts_on)}{f.ends_on !== f.starts_on && ` – ${shortDate(f.ends_on)}`}
                    {f.veg_only && <Badge tone="green">Veg</Badge>}
                  </span>
                </li>
              ))}
              {!festivals?.length && <li className="text-ink-500">Nothing in the next 60 days.</li>}
            </ul>
            <p className="mt-3 text-xs text-ink-500">Dates come from the Tiffin platform calendar (approximate; tell us if one is wrong).</p>
          </Card>
        </div>
      </div>
    </>
  );
}
