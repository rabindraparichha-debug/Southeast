'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ITEMS = [
  { href: '/admin', label: 'Dashboard' },
  { href: '/admin/kitchens', label: 'Kitchens' },
  { href: '/admin/leads', label: 'Leads' },
  { href: '/admin/funnel', label: 'Funnel & gaps' },
  { href: '/admin/vendors', label: 'Vendor applications' },
  { href: '/admin/reviews', label: 'Reviews' },
  { href: '/admin/audit', label: 'Audit log' },
];

export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto">
      {ITEMS.map((i) => {
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
