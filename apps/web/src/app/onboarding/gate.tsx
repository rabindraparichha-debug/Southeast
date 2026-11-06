import 'server-only';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import type { OnboardingStatus } from '@tiffin/db';
import { createClient } from '@/lib/supabase/server';
import { SupportLink } from '@/components/support-link';
import { SignOutButton } from '@/components/sign-out-button';

// Decides what "Set up your kitchen" shows (wave 4, D-126):
//  * invited staff and riders are joined to their kitchen and sent there (never offered a new one);
//  * if the invite check fails or an invite is still waiting (slow network), a retry, not the form;
//  * numbers the Tiffin team has not approved see how to get approved instead of the form.
export async function OnboardingGate({ children }: { children: ReactNode }) {
  const supabase = await createClient();
  // The login screen already claims invites; claiming again is harmless and covers a lost request.
  const claim = await supabase.rpc('claim_invites');
  const { data, error } = await supabase.rpc('onboarding_status');
  if (claim.error || error || !data) {
    return <Retry title="We could not check your account" text="The connection dropped while we checked whether a kitchen added you. Try again." />;
  }
  const status = data as unknown as OnboardingStatus;
  if (status.memberships > 0) redirect('/');
  if (status.pending_invites > 0) {
    return <Retry title="A kitchen added you" text="We are still joining you to it. Try again in a moment." />;
  }
  if (!status.can_create_kitchen && status.login_with_code) return <LoginWithCode />;
  if (!status.can_create_kitchen) return <NotApproved status={status} />;
  return <>{children}</>;
}

function Retry({ title, text }: { title: string; text: string }) {
  return (
    <div className="space-y-3 text-sm">
      <h2 className="text-base font-semibold text-ink-900">{title}</h2>
      <p className="text-ink-700">{text}</p>
      {/* A full reload runs the checks again. */}
      <a href="/onboarding" className="inline-flex w-full items-center justify-center rounded-lg bg-brand-600 px-4 py-2.5 font-medium text-white hover:bg-brand-700">
        Try again
      </a>
      <SupportLink />
    </div>
  );
}

// The number is confirmed but this login did not prove it with a code (a password login): only a
// code login counts for approval and invites.
function LoginWithCode() {
  return (
    <div className="space-y-3 text-sm">
      <h2 className="text-base font-semibold text-ink-900">Log in with a code</h2>
      <p className="text-ink-700">To set up a kitchen or join one, log out and log in again with the code we send to your phone.</p>
      <SupportLink text="Hello, I cannot set up my kitchen on Tiffin OS." />
      <div className="pt-2"><SignOutButton /></div>
    </div>
  );
}

function NotApproved({ status }: { status: OnboardingStatus }) {
  const app = status.application;
  return (
    <div className="space-y-3 text-sm">
      <h2 className="text-base font-semibold text-ink-900">Ask the Tiffin team to approve your number</h2>
      {app && app.status !== 'rejected' ? (
        <p className="text-ink-700">
          We have your application. Our team calls every new kitchen before it starts; once they approve this number you can set up
          your kitchen here.
        </p>
      ) : status.apply_open ? (
        <p className="text-ink-700">
          New kitchens start after a short call with our team. <Link href="/vendors" className="text-brand-700 hover:underline">Apply here</Link> with
          this number, or message us.
        </p>
      ) : (
        <p className="text-ink-700">New kitchens start after a short call with our team. Message us with this number and we will call you.</p>
      )}
      <p className="text-ink-500">
        If a kitchen owner added you as staff or rider, ask them to check they used this number.
      </p>
      <SupportLink text="Hello, please approve my number for Tiffin OS." />
      <div className="pt-2"><SignOutButton /></div>
    </div>
  );
}
