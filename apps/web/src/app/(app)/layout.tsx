import { redirect } from 'next/navigation';
import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { Nav, type NavItem } from '@/components/nav';
import { KitchenSwitcher } from '@/components/kitchen-switcher';
import { InstallApp } from '@/components/pwa';
import { SignOutButton } from '@/components/sign-out-button';
import { RiderSync } from '@/components/rider-sync';
import { LanguagePicker } from '@/components/language-picker';
import { getTranslator } from '@/lib/i18n/server';
import { translateNav } from '@/lib/i18n/translate';
import { SupportLink } from '@/components/support-link';
import { canReadMoney, isLead } from '@/lib/roles';

export default async function AppLayout({ children }: LayoutProps<'/'>) {
  const session = await requireKitchen();
  const role = session.kitchen.role;
  const { lang, t } = await getTranslator(); // D-130: nav and Today only so far
  // Riders only use rider mode (phone-first, works offline).
  if (role === 'rider') redirect('/rider');

  // D-117/D-146: managers get every owner page except the owner-only ones (inbox, settings, team);
  // accountants get the money pages, read-only.
  const lead = isLead(role);
  const supabase = await createClient();
  const items: NavItem[] = [];
  if (role !== 'accountant') items.push({ href: '/', label: 'Today', icon: '📋' });
  items.push({ href: '/customers', label: 'Customers', icon: '👥' });
  if (lead) {
    const { count: requests } = await supabase.from('change_requests').select('id', { count: 'exact', head: true })
      .eq('kitchen_id', session.kitchen.kitchenId).eq('status', 'pending');
    items.push({ href: '/requests', label: requests ? `Rider requests (${requests})` : 'Rider requests', icon: '📨' });
  }
  if (role === 'owner' || role === 'manager' || role === 'staff') {
    if (lead) items.push({ href: '/desk', label: 'Phone desk', icon: '📞' });
    items.push({ href: '/sheet', label: 'Kitchen sheet', icon: '🧾' });
    items.push({ href: '/delivery', label: 'Delivery', icon: '🛵' });
    if (role === 'owner') items.push({ href: '/rider', label: 'Deliver', icon: '📍' });
    items.push({ href: '/menu', label: 'Menu', icon: '📅' });
    items.push({ href: '/inventory', label: 'Inventory', icon: '📦' });
    items.push({ href: '/stock-entry', label: 'Stock entry', icon: '📝' });
  }
  if (role === 'owner') {
    const { count: needsReply } = await supabase.from('conversations').select('id', { count: 'exact', head: true })
      .eq('kitchen_id', session.kitchen.kitchenId).or('unread_count.gt.0,handoff_open.eq.true');
    items.push({ href: '/inbox', label: needsReply ? `Inbox (${needsReply})` : 'Inbox', icon: '💬' });
  }
  if (canReadMoney(role)) {
    items.push({ href: '/money', label: 'Money', icon: '💰' });
    items.push({ href: '/money/bills', label: 'Bills', icon: '🧮' });
    items.push({ href: '/reports/costs', label: 'Costs', icon: '📊' });
  }
  if (lead) {
    items.push({ href: '/insights', label: 'Insights', icon: '💡' });
    items.push({ href: '/plans', label: 'Plans', icon: '🍛' });
  }
  if (role === 'owner') {
    items.push({ href: '/settings', label: 'Kitchen settings', icon: '⚙️' });
    items.push({ href: '/team', label: 'Team', icon: '🧑‍🍳' });
  }
  if (session.isAdmin) items.push({ href: '/admin', label: 'Admin', icon: '🛡️' });

  return (
    <div className="min-h-screen md:flex" lang={lang}>
      <aside className="border-b border-ink-200 bg-white p-3 print:hidden md:sticky md:top-0 md:h-screen md:w-60 md:shrink-0 md:border-r md:border-b-0 md:p-4">
        <div className="mb-3 flex items-center gap-2 md:mb-6">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white">🍱</span>
          <div className="min-w-0 flex-1">
            <KitchenSwitcher memberships={session.memberships} current={session.kitchen} />
          </div>
        </div>
        <form action="/customers" className="mb-3">
          <input
            name="q"
            type="search"
            placeholder={t('nav.search')}
            className="w-full rounded-lg border-0 bg-ink-50 px-3 py-2 text-sm ring-1 ring-ink-200 focus:ring-2 focus:ring-brand-500"
          />
        </form>
        <Nav items={translateNav(items, lang)} />
        <div className="mt-3 flex items-start justify-between gap-3 md:absolute md:bottom-4 md:mt-0 md:block md:space-y-3">
          <InstallApp />
          <LanguagePicker current={lang} />
          <SupportLink className="block text-xs text-brand-700 hover:underline" />
          <SignOutButton />
        </div>
      </aside>
      {/* Owners deliver too: their queued rider actions keep syncing from any page. */}
      {role === 'owner' && <RiderSync userId={session.userId} />}
      <main className="min-w-0 flex-1 p-4 md:p-8 print:p-0">{children}</main>
    </div>
  );
}
