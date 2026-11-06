'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';

// After switching GOOGLE_ADS_MODE to live: queue every mock-handled conversion for upload (D-151).
export function RequeueMock() {
  const router = useRouter();
  const [state, setState] = useState<string | null>(null);
  async function requeue() {
    setState('…');
    const { data, error } = await supabaseBrowser().rpc('admin_requeue_mock_conversions');
    if (error) return setState(friendlyError(error));
    setState(`${data ?? 0} queued`);
    router.refresh();
  }
  return (
    <>
      <button type="button" onClick={requeue} className="font-medium text-brand-700 underline">queue them now</button>
      {state && <span className="ml-1 text-ink-600">({state})</span>}
    </>
  );
}
