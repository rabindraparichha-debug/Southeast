import Link from 'next/link';
import type { ReactNode } from 'react';
import { requireAdmin } from '@/lib/session';
import { AdminNav } from './admin-nav';

// Platform team console. Every page re-checks admin in its RPCs; this only adds the navigation.
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const session = await requireAdmin();
  return (
    <div className="min-h-screen">
      <header className="border-b border-ink-200 bg-white print:hidden">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-2 md:px-8">
          <div className="flex items-center gap-3">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-600 text-sm text-white" aria-hidden>🛡️</span>
            <AdminNav />
          </div>
          {session.kitchen && <Link href="/" className="text-sm text-ink-500 hover:text-ink-800">My kitchen →</Link>}
        </div>
      </header>
      {children}
    </div>
  );
}
