import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { createClient } from '@/lib/supabase/server';
import { firstParam, type ReferralInvite } from '@/lib/public';
import { Alert } from '@/components/ui';
import { JoinForm } from './join-form';

export const metadata: Metadata = {
  title: 'Join with a friend’s invite · Tiffin Bhubaneswar',
  robots: { index: false, follow: false },
};

type Loaded = { invite: ReferralInvite } | { off: true } | null;

const load = cache(async (slug: string, code: string): Promise<Loaded> => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('referral_invite', { p_slug: slug, p_code: code });
  if (error) return error.message === 'feature_disabled' ? { off: true } : null;
  return { invite: data as unknown as ReferralInvite };
});

// A customer's share link (D-147): only this kitchen, never others. The friend joins this kitchen
// with a trial; the kitchen calls to confirm.
export default async function JoinPage({ params, searchParams }: PageProps<'/k/[slug]/join'>) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const code = firstParam(sp.ref) ?? '';
  const loaded = await load(slug, code);
  if (!loaded) notFound();
  if ('off' in loaded) {
    return (
      <div className="mx-auto max-w-lg">
        <h1 className="mb-2 text-2xl font-semibold text-ink-900">Invites are not open yet</h1>
        <p className="text-ink-700">Joining with a friend’s link is not switched on yet. Please call the kitchen your friend uses.</p>
      </div>
    );
  }
  const { invite } = loaded;
  const k = invite.kitchen;

  if (invite.code_status !== 'ok') {
    return (
      <div className="mx-auto max-w-lg space-y-3">
        <h1 className="text-2xl font-semibold text-ink-900">{k.name}</h1>
        <Alert tone="amber">
          {invite.code_status === 'other_kitchen'
            ? `This invite code belongs to a different kitchen, not ${k.name}. Ask your friend to share their link again.`
            : `This invite link is not valid for ${k.name}. Ask your friend to share their link again.`}
        </Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <header className="space-y-1">
        <p className="text-sm text-ink-500">A friend invited you to</p>
        <h1 className="text-2xl font-semibold text-ink-900">{k.name}</h1>
        <p className="text-sm text-ink-500">{[k.area, 'Bhubaneswar'].filter(Boolean).join(', ')}{k.fssai_no ? ` · FSSAI Reg. No. ${k.fssai_no}` : ''}</p>
      </header>
      <div className="rounded-2xl bg-brand-50 p-4 text-sm text-ink-800 ring-1 ring-brand-100">
        Start with a {k.trial_meals}-meal trial. The kitchen calls you to confirm, and you pay the kitchen directly.
        {invite.reward_meals > 0 && ` After your first payment, you and your friend each get ${invite.reward_meals} free meal${invite.reward_meals === 1 ? '' : 's'}.`}
      </div>
      {invite.plans.length
        ? <JoinForm slug={k.slug} code={invite.code ?? code} kitchenName={k.name} plans={invite.plans} />
        : <Alert tone="amber">This kitchen has no plans open right now. Please call them.</Alert>}
    </div>
  );
}
