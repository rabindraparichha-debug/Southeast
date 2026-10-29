import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { signOut } from '@/app/actions';
import { Nav, type NavItem } from '@/components/nav';
import { KitchenSwitcher } from '@/components/kitchen-switcher';

export default async function AppLayout({ children }: LayoutProps<'/'>) {
  const session = await requireKitchen();
  const role = session.kitchen.role;

  const items: NavItem[] = [{ href: '/', label: 'Today', icon: '📋' }];
  if (role === 'owner' || role === 'staff') {
    items.push({ href: '/customers', label: 'Customers', icon: '👥' });
    items.push({ href: '/sheet', label: 'Kitchen sheet', icon: '🧾' });
    items.push({ href: '/delivery', label: 'Delivery', icon: '🛵' });
    items.push({ href: '/menu', label: 'Menu', icon: '📅' });
    items.push({ href: '/inventory', label: 'Inventory', icon: '📦' });
  }
  if (role === 'owner') {
    const supabase = await createClient();
    const { count: needsReply } = await supabase.from('conversations').select('id', { count: 'exact', head: true })
      .eq('kitchen_id', session.kitchen.kitchenId).or('unread_count.gt.0,handoff_open.eq.true');
    items.push({ href: '/inbox', label: needsReply ? `Inbox (${needsReply})` : 'Inbox', icon: '💬' });
    items.push({ href: '/money', label: 'Money', icon: '💰' });
    items.push({ href: '/reports/costs', label: 'Costs', icon: '📊' });
    items.push({ href: '/plans', label: 'Plans', icon: '🍛' });
    items.push({ href: '/settings', label: 'Kitchen settings', icon: '⚙️' });
    items.push({ href: '/team', label: 'Team', icon: '🧑‍🍳' });
  }
  if (session.isAdmin) items.push({ href: '/admin', label: 'Admin', icon: '🛡️' });

  return (
    <div className="min-h-screen md:flex">
      <aside className="border-b border-ink-200 bg-white p-3 print:hidden md:sticky md:top-0 md:h-screen md:w-60 md:shrink-0 md:border-r md:border-b-0 md:p-4">
        <div className="mb-3 flex items-center gap-2 md:mb-6">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white">🍱</span>
          <div className="min-w-0 flex-1">
            <KitchenSwitcher memberships={session.memberships} current={session.kitchen} />
          </div>
        </div>
        {role !== 'rider' && (
          <form action="/customers" className="mb-3">
            <input
              name="q"
              type="search"
              placeholder="Search name, phone, area…"
              className="w-full rounded-lg border-0 bg-ink-50 px-3 py-2 text-sm ring-1 ring-ink-200 focus:ring-2 focus:ring-brand-500"
            />
          </form>
        )}
        <Nav items={items} />
        <form action={signOut} className="mt-3 md:absolute md:bottom-4 md:mt-0">
          <button className="text-sm text-ink-500 hover:text-ink-800">Log out</button>
        </form>
      </aside>
      <main className="min-w-0 flex-1 p-4 md:p-8 print:p-0">{children}</main>
    </div>
  );
}
