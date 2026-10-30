import Link from 'next/link';
import { requireKitchen } from '@/lib/session';
import { KitchenSwitcher } from '@/components/kitchen-switcher';
import { InstallApp } from '@/components/pwa';
import { SignOutButton } from '@/components/sign-out-button';

// Phone-first shell for rider mode and stock entry: no dashboard sidebar, big touch targets,
// and both pages keep working offline once opened (see public/sw.js).
export default async function FieldLayout({ children }: LayoutProps<'/'>) {
  const session = await requireKitchen();
  const role = session.kitchen.role;
  return (
    <div className="mx-auto min-h-screen max-w-xl pb-[env(safe-area-inset-bottom)]">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-ink-200 bg-white/95 px-4 py-2.5 backdrop-blur pt-[max(0.625rem,env(safe-area-inset-top))]">
        {role === 'rider' ? (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-white" aria-hidden>🍱</span>
        ) : (
          <Link href="/" className="shrink-0 rounded-lg px-1 py-1 text-sm font-medium text-brand-700" data-testid="to-dashboard">← Dashboard</Link>
        )}
        <div className="min-w-0 flex-1">
          <KitchenSwitcher memberships={session.memberships} current={session.kitchen} />
        </div>
        <SignOutButton formClassName="shrink-0 text-right" />
      </header>
      <div className="space-y-3 p-4">
        <InstallApp variant="banner" />
        {children}
      </div>
    </div>
  );
}
