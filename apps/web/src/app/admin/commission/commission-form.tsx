'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Button, Input } from '@/components/ui';

/** Commission rate in percent (stored as basis points, 0–3000). */
export function CommissionForm({ kitchenId, bps }: { kitchenId: string; bps: number }) {
  const router = useRouter();
  const [pct, setPct] = useState(String(bps / 100));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function save(e: FormEvent) {
    e.preventDefault();
    const value = Math.round(Number(pct) * 100);
    if (!Number.isFinite(value) || pct.trim() === '') return setMsg(friendlyError({ message: 'invalid_commission' }));
    setBusy(true);
    setMsg('');
    const { error } = await supabaseBrowser().rpc('admin_set_commission', { p_kitchen: kitchenId, p_bps: value });
    setBusy(false);
    if (error) return setMsg(friendlyError(error));
    setMsg('Saved');
    router.refresh();
  }

  return (
    <form onSubmit={save} className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1 text-sm">
        <Input value={pct} onChange={(e) => setPct(e.target.value)} inputMode="decimal" className="w-20" aria-label="Commission percent" />%
      </label>
      <Button type="submit" variant="secondary" disabled={busy || Math.round(Number(pct) * 100) === bps}>Set</Button>
      {msg && <span className={`text-xs ${msg === 'Saved' ? 'text-green-700' : 'text-red-700'}`}>{msg}</span>}
    </form>
  );
}
