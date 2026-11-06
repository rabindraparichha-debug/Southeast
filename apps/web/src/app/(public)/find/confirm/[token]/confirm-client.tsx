'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyErrorIn } from '@/lib/errors';
import type { LeadChoice } from '@/lib/public';
import { Chosen, startPayment, store, type Saved } from '../../find-client';

/** lead_confirm's answer. A second opening shows the booking without a new page link (D-144). */
type Confirmed = Omit<LeadChoice, 'portal_token' | 'portal_url'> & {
  already_confirmed?: boolean;
  portal_token: string | null;
  portal_url: string | null;
};

/** The booking this browser saved when the link was first opened (it holds the page link), if any. */
function savedBooking(customerId: string): Saved | null {
  try {
    const raw = store.get();
    const saved = raw ? (JSON.parse(raw) as Saved) : null;
    return saved?.choice?.customer_id === customerId && saved.choice.portal_token ? saved : null;
  } catch {
    return null;
  }
}

export function ConfirmClient({ token }: { token: string }) {
  const [saved, setSaved] = useState<Saved | null>(null);
  const [already, setAlready] = useState<Confirmed | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabaseBrowser().rpc('lead_confirm', { p_token: token });
      if (cancelled) return;
      if (error || !data) return setError(friendlyErrorIn('public', error));
      const answer = data as unknown as Confirmed;
      if (answer.already_confirmed || !answer.portal_token) {
        const earlier = savedBooking(answer.customer_id);
        if (earlier) return setSaved(earlier);
        return setAlready(answer);
      }
      const choice = { ...answer, portal_token: answer.portal_token, portal_url: answer.portal_url ?? '', kitchen_id: '' };
      const base: Saved = { token: '', result: { token: '', status: 'trial', area: null, kitchens: [] }, choice };
      store.set(base);
      const pay = await startPayment(choice, null);
      if (cancelled || pay === 'redirected') return;
      const next = { ...base, payment: pay };
      store.set(next);
      setSaved(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (error) {
    return (
      <div className="mx-auto max-w-lg rounded-2xl bg-white p-6 text-center shadow-sm ring-1 ring-ink-100">
        <div className="text-4xl" aria-hidden>🔗</div>
        <h1 className="mt-2 text-lg font-semibold">This link did not work</h1>
        <p className="mt-1 text-sm text-ink-700">{error}</p>
        <Link href="/find" className="mt-4 inline-block text-sm text-brand-700 underline">Search again</Link>
      </div>
    );
  }
  if (already) {
    return (
      <div className="mx-auto max-w-lg rounded-2xl bg-white p-6 text-center shadow-sm ring-1 ring-ink-100">
        <div className="text-4xl" aria-hidden>✅</div>
        <h1 className="mt-2 text-lg font-semibold">Already confirmed with {already.kitchen_name}</h1>
        <p className="mt-1 text-sm text-ink-700">
          This link was used to confirm your trial. For your customer page, use the link you opened the first time,
          or ask {already.kitchen_name} to send you a new one.
        </p>
      </div>
    );
  }
  if (!saved) {
    return <p className="mx-auto max-w-lg text-center text-sm text-ink-500" role="status">Confirming your trial…</p>;
  }
  return <Chosen saved={saved} />;
}
