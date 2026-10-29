import Link from 'next/link';
import type { ReactNode } from 'react';
import { AnalyticsProvider } from '@/components/analytics-provider';

// Light chrome for the public website (no login): customers looking for a tiffin and kitchen owners.
export default function PublicLayout({ children }: { children: ReactNode }) {
  const grievance = process.env.NEXT_PUBLIC_GRIEVANCE_CONTACT ?? '';
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <AnalyticsProvider />
      <header className="sticky top-0 z-20 border-b border-ink-100 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3">
          <Link href="/find" className="flex items-center gap-2 font-semibold text-ink-900">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-600 text-sm text-white" aria-hidden>🍱</span>
            Tiffin Bhubaneswar
          </Link>
          <nav className="flex gap-4 text-sm text-ink-700">
            <Link href="/find" className="hover:text-brand-700">Find a tiffin</Link>
            <Link href="/kitchens" className="hover:text-brand-700">Kitchens</Link>
            <Link href="/vendors" className="hover:text-brand-700">For kitchen owners</Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">{children}</main>
      <footer className="border-t border-ink-100 bg-ink-50">
        <div className="mx-auto max-w-5xl space-y-1 px-4 py-6 text-xs text-ink-500">
          <p className="font-medium text-ink-700">We never hold your money: you pay the kitchen directly.</p>
          <p>Every listed kitchen has an FSSAI registration number shown on its page.</p>
          {grievance && <p>{grievance}</p>}
          <p className="flex flex-wrap gap-x-4 gap-y-1 pt-1">
            <Link href="/privacy" className="underline hover:text-ink-800">Privacy policy</Link>
            <Link href="/terms" className="underline hover:text-ink-800">Terms of use</Link>
            <Link href="/login" className="underline hover:text-ink-800">Kitchen login</Link>
          </p>
          <p>© Tiffin Bhubaneswar · Free software for home kitchens and tiffin services.</p>
        </div>
      </footer>
    </div>
  );
}
