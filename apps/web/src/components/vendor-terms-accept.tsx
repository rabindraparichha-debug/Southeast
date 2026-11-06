'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { DPA_VERSION, VENDOR_TERMS_VERSION } from '@/lib/legal-versions';
import { Alert, Button } from './ui';

/** The checkbox text and links, shared by onboarding and the accept page. */
export function TermsLabel() {
  return (
    <span>
      I accept the{' '}
      <Link href="/legal/vendor-terms" target="_blank" className="text-brand-700 underline">vendor terms</Link> and the{' '}
      <Link href="/legal/dpa" target="_blank" className="text-brand-700 underline">data processing agreement</Link> for my kitchen
      (drafts {VENDOR_TERMS_VERSION}).
    </span>
  );
}

/** Records the owner's acceptance (consents, D-142). The versions are the ones these pages show. */
export async function acceptVendorTerms(kitchenId: string) {
  return supabaseBrowser().rpc('accept_vendor_terms', {
    p_kitchen: kitchenId, p_terms_version: VENDOR_TERMS_VERSION, p_dpa_version: DPA_VERSION, p_channel: 'web',
  });
}

export function VendorTermsAccept({ kitchenId }: { kitchenId: string }) {
  const router = useRouter();
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function accept() {
    setBusy(true);
    setError('');
    const { error } = await acceptVendorTerms(kitchenId);
    setBusy(false);
    if (error) return setError(friendlyError(error));
    router.replace('/');
    router.refresh();
  }
  return (
    <div className="space-y-4">
      <label className="flex items-start gap-2 text-sm text-ink-700">
        <input type="checkbox" className="mt-0.5" checked={checked} onChange={(e) => setChecked(e.target.checked)} data-testid="accept-terms" />
        <TermsLabel />
      </label>
      <Alert>{error}</Alert>
      <Button className="w-full" disabled={!checked || busy} onClick={accept}>{busy ? 'Saving…' : 'Accept and continue'}</Button>
    </div>
  );
}
