import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { OnboardingForm } from './onboarding-form';

export default async function OnboardingPage() {
  const session = await getSession();
  if (session.kitchen) redirect('/');
  return (
    <main className="mx-auto max-w-lg px-4 py-12">
      <h1 className="text-xl font-semibold">Set up your kitchen</h1>
      <p className="mt-1 text-sm text-ink-500">
        Free for vendors. You can change all of this later in Settings. If someone already added you to their
        kitchen as staff or rider, ask them to check the number they used.
      </p>
      <div className="mt-6 rounded-xl bg-white p-6 shadow-sm ring-1 ring-ink-100">
        <OnboardingForm />
      </div>
    </main>
  );
}
