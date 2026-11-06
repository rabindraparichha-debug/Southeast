'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { Flag, Flags } from '@/lib/flag-keys';

// Pages of a switched-off phase drop out of the menu (D-141). "Phase switches" and "Kitchen
// switching" stay: that is where the platform team turns them on.
const ITEMS: { href: string; label: string; needs?: Flag[] }[] = [
  { href: '/admin', label: 'Dashboard' },
  { href: '/admin/kitchens', label: 'Kitchens' },
  { href: '/admin/flags', label: 'Phase switches' },
  { href: '/admin/leads', label: 'Leads', needs: ['marketplace', 'growth'] },
  { href: '/admin/funnel', label: 'Funnel & gaps', needs: ['marketplace', 'growth'] },
  { href: '/admin/vendors', label: 'Vendor applications', needs: ['growth'] },
  { href: '/admin/reviews', label: 'Reviews', needs: ['marketplace'] },
  { href: '/admin/quality', label: 'Complaint scores', needs: ['extras'] },
  { href: '/admin/calendar', label: 'Food calendar' },
  { href: '/admin/commission', label: 'Commission', needs: ['online_payments'] },
  { href: '/admin/switching', label: 'Kitchen switching' },
  { href: '/admin/audit', label: 'Audit log' },
];

export function AdminNav({ flags }: { flags: Flags }) {
  const pathname = usePathname();
  const items = ITEMS.filter((i) => !i.needs || i.needs.some((f) => flags[f]));
  return (
    <nav className="flex min-w-0 gap-1 overflow-x-auto">
      {items.map((i) => {
        const active = i.href === '/admin' ? pathname === '/admin' : pathname.startsWith(i.href);
        return (
          <Link key={i.href} href={i.href}
            className={`shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium ${active ? 'bg-brand-50 text-brand-700' : 'text-ink-700 hover:bg-ink-100'}`}>
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
