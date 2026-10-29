'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** Sub-navigation for the inventory section (owner + staff; supplier dues inside are owner-only). */
export function InventoryTabs() {
  const pathname = usePathname();
  const tabs = [
    { href: '/inventory', label: 'Stock' },
    { href: '/inventory/purchases', label: 'Purchases' },
    { href: '/inventory/suppliers', label: 'Suppliers' },
    { href: '/inventory/recipes', label: 'Recipes' },
    { href: '/inventory/stock-take', label: 'Stock-take' },
  ];
  return (
    <nav className="mb-6 flex gap-1 overflow-x-auto border-b border-ink-200 print:hidden">
      {tabs.map((t) => {
        const active = t.href === '/inventory' ? pathname === '/inventory' : pathname.startsWith(t.href);
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
