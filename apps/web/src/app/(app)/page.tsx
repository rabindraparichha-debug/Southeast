import { redirect } from 'next/navigation';
import { addDays, istDate } from '@tiffin/core';
import type { MealSlot, SlotSummary } from '@tiffin/db';
import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { Card, LinkButton, PageHeader, Stat } from '@/components/ui';
import { SlotCard } from '@/components/slot-card';
import { ChangeFeed } from '@/components/change-feed';
import { OnboardingChecklist } from '@/components/onboarding-checklist';
import { checklistItems } from '@/lib/checklist';
import { UpcomingClosures } from './upcoming-closures';
import { getTranslator } from '@/lib/i18n/server';
import { localeOf } from '@/lib/i18n/translate';

export default async function TodayPage() {
  const { kitchen } = await requireKitchen();
  const supabase = await createClient();
  const { lang, t } = await getTranslator(); // Odia/Hindi drafts (D-130)

  if (kitchen.role === 'rider') redirect('/rider');

  const today = istDate();
  const slots: [string, MealSlot][] = [[today, 'lunch'], [today, 'dinner'], [addDays(today, 1), 'lunch'], [addDays(today, 1), 'dinner']];
  const [summaries, { data: changes }, { count: customerCount }] = await Promise.all([
    Promise.all(slots.map(([d, s]) => supabase.rpc('slot_summary', { p_kitchen: kitchen.kitchenId, p_date: d, p_slot: s }))),
    supabase.rpc('change_feed', { p_kitchen: kitchen.kitchenId, p_limit: 30 }),
    supabase.from('customers_v').select('id', { count: 'exact', head: true }).eq('kitchen_id', kitchen.kitchenId),
  ]);
  const isOwner = kitchen.role === 'owner';

  let active = 0;
  let paused = 0;
  let checklist: ReturnType<typeof checklistItems> = [];
  if (isOwner) {
    const [{ data: subs }, { data: list }] = await Promise.all([
      supabase.from('subscriptions').select('status').eq('kitchen_id', kitchen.kitchenId),
      supabase.rpc('kitchen_checklist', { p_kitchen: kitchen.kitchenId }),
    ]);
    checklist = checklistItems(list);
    active = (subs ?? []).filter((s) => s.status === 'active' || s.status === 'low_balance').length;
    paused = (subs ?? []).filter((s) => s.status === 'paused').length;
  }

  return (
    <>
      <PageHeader
        title={t('today.title')}
        subtitle={new Date().toLocaleDateString(localeOf(lang), { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long' })}
        actions={<LinkButton href="/menu" variant="secondary">{t('today.menu')}</LinkButton>}
      />

      {isOwner && <OnboardingChecklist items={checklist} />}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {summaries.map((r, i) => r.data && <SlotCard key={i} s={r.data as unknown as SlotSummary} />)}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card title={t('today.changes')} className="lg:col-span-2">
          <ChangeFeed changes={changes ?? []} linkCustomers={isOwner || kitchen.role === 'staff'} />
        </Card>
        <div className="space-y-4">
          <Stat label={t('today.customers')} value={customerCount ?? 0} />
          <UpcomingClosures kitchenId={kitchen.kitchenId} canEdit={isOwner} />
          {isOwner && <Stat label={t('today.active')} value={active} hint={paused ? t('today.paused', { n: paused }) : undefined} />}
          {isOwner && (
            <div className="flex flex-wrap gap-2">
              <LinkButton href="/customers/new">{t('today.addCustomer')}</LinkButton>
              <LinkButton href="/customers/import" variant="secondary">{t('today.import')}</LinkButton>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
