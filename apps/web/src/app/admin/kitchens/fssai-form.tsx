'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Button, Input } from '@/components/ui';

// Platform correction of a kitchen's FSSAI number (admin_set_fssai). Owners can't change it once the
// kitchen is listed (fssai_locked). Empty clears it, which a listed kitchen refuses (check constraint).
export function FssaiForm({ kitchenId, fssai }: { kitchenId: string; fssai: string | null }) {
  const router = useRouter();
  const [value, setValue] = useState(fssai ?? '');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const clean = value.replace(/\s/g, '');
  const changed = clean !== (fssai ?? '');

  async function save() {
    setMsg(null);
    if (clean && !/^\d{14}$/.test(clean)) return setMsg({ ok: false, text: friendlyError({ message: 'invalid_fssai' }) });
    setBusy(true);
    const { error } = await supabaseBrowser().rpc('admin_set_fssai', { p_kitchen: kitchenId, p_fssai: (clean || null) as string });
    setBusy(false);
    if (error) return setMsg({ ok: false, text: friendlyError(error) });
    setMsg({ ok: true, text: clean ? 'FSSAI number saved' : 'FSSAI number cleared' });
    router.refresh();
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <Input
          aria-label="FSSAI number" className="w-44 py-1 font-mono text-xs" inputMode="numeric" maxLength={17}
          placeholder="14-digit FSSAI no." value={value} onChange={(e) => setValue(e.target.value)}
        />
        <Button variant="secondary" className="px-2 py-1 text-xs" disabled={!changed || busy} onClick={save}>
          {busy ? 'Saving…' : 'Correct'}
        </Button>
      </div>
      {msg && <p role="status" className={`text-xs ${msg.ok ? 'text-green-700' : 'text-red-700'}`}>{msg.text}</p>}
    </div>
  );
}
