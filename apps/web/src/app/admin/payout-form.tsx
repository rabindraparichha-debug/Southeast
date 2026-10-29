'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Button, Input, Select } from '@/components/ui';

// Admin records the kitchen's Razorpay Route linked account after KYC in the Razorpay dashboard.
export function PayoutForm({ kitchenId, accountId, kycStatus }: { kitchenId: string; accountId: string | null; kycStatus: string }) {
  const router = useRouter();
  const [acc, setAcc] = useState(accountId ?? '');
  const [status, setStatus] = useState(kycStatus);
  const [msg, setMsg] = useState('');
  async function save() {
    const { error } = await supabaseBrowser().rpc('set_payout_account', { p_kitchen: kitchenId, p_account_id: (acc.trim() || null) as string, p_kyc_status: status });
    setMsg(error ? friendlyError(error) : 'Saved');
    if (!error) router.refresh();
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Input className="w-40 py-1 text-xs" placeholder="acc_XXXXXXXX" value={acc} onChange={(e) => setAcc(e.target.value)} />
      <Select className="w-28 py-1 text-xs" value={status} onChange={(e) => setStatus(e.target.value)}>
        {['not_started', 'pending', 'verified', 'rejected'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
      </Select>
      <Button variant="secondary" className="px-2 py-1 text-xs" onClick={save}>Save</Button>
      {msg && <span className="text-xs text-ink-500">{msg}</span>}
    </div>
  );
}
