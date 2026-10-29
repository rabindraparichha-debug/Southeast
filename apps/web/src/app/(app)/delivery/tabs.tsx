'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** Sub-navigation for the delivery section. Rider pay numbers are owner-only. */
export function DeliveryTabs({ isOwner }: { isOwner: boolean }) {
  const pathname = usePathname();
  const tabs = [
    { href: '/delivery', label: 'Live board' },
    { href: '/delivery/routes', label: 'Routes' },
    { href: '/delivery/tiffins', label: 'Tiffins' },
    ...(isOwner ? [{ href: '/delivery/riders', label: 'Riders' }] : []),
  ];
  return (
    <nav className="mb-6 flex gap-1 overflow-x-auto border-b border-ink-200">
      {tabs.map((t) => {
        const active = t.href === '/delivery' ? pathname === '/delivery' : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-medium ${
              active ? 'border-brand-600 text-brand-700' : 'border-transparent text-ink-600 hover:text-ink-900'
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
