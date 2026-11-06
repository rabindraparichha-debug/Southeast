'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyErrorIn } from '@/lib/errors';
import type { LeadChoice } from '@/lib/public';
import { Chosen, startPayment, store, type Saved } from '../../find-client';

export function ConfirmClient({ token }: { token: string }) {
  const [saved, setSaved] = useState<Saved | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabaseBrowser().rpc('lead_confirm', { p_token: token });
      if (cancelled) return;
      if (error || !data) return setError(friendlyErrorIn('public', error));
      const choice = { ...(data as unknown as LeadChoice), kitchen_id: '' };
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
  if (!saved) {
    return <p className="mx-auto max-w-lg text-center text-sm text-ink-500" role="status">Confirming your trial…</p>;
  }
  return <Chosen saved={saved} />;
}
