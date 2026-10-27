import { addDays, cutoffInstant, formatTime12h, istDate, isoDow, WEEKDAYS } from '@tiffin/core';
import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { Card, LinkButton, PageHeader, Stat } from '@/components/ui';

const IST = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export default async function TodayPage() {
  const { kitchen } = await requireKitchen();
  const supabase = await createClient();
  const { data: k } = await supabase.from('kitchens').select('*').eq('id', kitchen.kitchenId).single();
  if (!k) return null;

  const today = istDate();
  const tomorrow = addDays(today, 1);
  const offToday = k.weekly_off.includes(isoDow(today));
  const offTomorrow = k.weekly_off.includes(isoDow(tomorrow));
  const lunchCutoff = cutoffInstant(tomorrow, k.cutoff_lunch, k.cutoff_lunch_prev_day);
  const dinnerCutoff = cutoffInstant(today, k.cutoff_dinner, k.cutoff_dinner_prev_day);

  if (kitchen.role === 'rider') {
    return (
      <>
        <PageHeader title="Today" />
        <Card>
          <p className="text-sm text-ink-600">Your stop list will appear in the rider mode of the mobile app.</p>
        </Card>
      </>
    );
  }

  const isOwner = kitchen.role === 'owner';
  const { count: customerCount } = await supabase
    .from('customers_v')
    .select('id', { count: 'exact', head: true })
    .eq('kitchen_id', kitchen.kitchenId);

  let byStatus: Record<string, number> = {};
  if (isOwner) {
    const { data: subs } = await supabase.from('subscriptions').select('status').eq('kitchen_id', kitchen.kitchenId);
    byStatus = (subs ?? []).reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.status]: (acc[s.status] ?? 0) + 1 }), {});
  }

  return (
    <>
      <PageHeader title="Today" subtitle={new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long' })} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Customers" value={customerCount ?? 0} />
        {isOwner && <Stat label="Active subscriptions" value={(byStatus.active ?? 0) + (byStatus.low_balance ?? 0)} />}
        {isOwner && <Stat label="On trial" value={byStatus.trial ?? 0} />}
        <Stat label="Capacity" value={`${k.capacity_lunch} / ${k.capacity_dinner}`} hint="Lunch / dinner tiffins per day" />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card title="Change windows">
          <ul className="space-y-3 text-sm">
            <li className="flex justify-between gap-4">
              <span>Tomorrow’s lunch {offTomorrow && <em className="text-ink-500">(weekly off)</em>}</span>
              <span className="text-ink-600">closes {IST.format(lunchCutoff)}</span>
            </li>
            <li className="flex justify-between gap-4">
              <span>Today’s dinner {offToday && <em className="text-ink-500">(weekly off)</em>}</span>
              <span className="text-ink-600">closes {IST.format(dinnerCutoff)}</span>
            </li>
          </ul>
          <p className="mt-4 text-xs text-ink-500">
            Lunch cutoff {formatTime12h(k.cutoff_lunch)} {k.cutoff_lunch_prev_day ? 'the day before' : 'same day'} · Dinner cutoff{' '}
            {formatTime12h(k.cutoff_dinner)} {k.cutoff_dinner_prev_day ? 'the day before' : 'same day'}
            {k.weekly_off.length > 0 && ` · Weekly off: ${k.weekly_off.map((d) => WEEKDAYS[d - 1]?.short).join(', ')}`}
          </p>
        </Card>

        <Card title="Meal counts">
          <p className="text-sm text-ink-600">
            Daily counts, the change feed and the production sheet start with the daily engine (next milestone).
          </p>
          {isOwner && (
            <div className="mt-4 flex flex-wrap gap-2">
              <LinkButton href="/customers/new">Add customer</LinkButton>
              <LinkButton href="/customers/import" variant="secondary">Import from Excel</LinkButton>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
