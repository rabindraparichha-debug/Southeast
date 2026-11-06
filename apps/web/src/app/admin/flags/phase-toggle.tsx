'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Button } from '@/components/ui';

export function PhaseToggle({ flag, label, enabled }: { flag: string; label: string; enabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function toggle() {
    const next = !enabled;
    if (!window.confirm(`${next ? 'Turn ON' : 'Turn OFF'} "${label}" for every kitchen?`)) return;
    setBusy(true);
    setError('');
    const { error } = await supabaseBrowser().rpc('admin_set_platform_flag', { p_key: flag, p_enabled: next });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    router.refresh();
  }
  return (
    <span className="flex items-center gap-2">
      <Button variant={enabled ? 'secondary' : 'danger'} onClick={toggle} disabled={busy} data-testid={`flag-${flag}`}>
        {enabled ? 'Turn off' : 'Turn on'}
      </Button>
      {error && <span className="text-xs text-red-700">{error}</span>}
    </span>
  );
}
