'use client';

import { useRef, useState } from 'react';
import { signOut } from '@/app/actions';
import { friendlyError } from '@/lib/errors';
import { queuedCount, resetRider, syncQueue } from '@/lib/rider-store';
import { clearOfflinePages } from './pwa';

/**
 * Log out, but never while rider actions are still queued on this device (they would be lost).
 * Clears the offline cache so the next person on a shared phone starts clean.
 */
export function SignOutButton({ className, formClassName }: { className?: string; formClassName?: string }) {
  const form = useRef<HTMLFormElement>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const onClick = async () => {
    setError('');
    setBusy(true);
    try {
      if ((await queuedCount()) > 0) {
        await syncQueue(); // one last try
        if ((await queuedCount()) > 0) {
          setError(friendlyError({ message: 'queued_logout' }));
          return;
        }
      }
      await resetRider();
      await clearOfflinePages();
    } finally {
      setBusy(false);
    }
    form.current?.requestSubmit();
  };

  return (
    <form ref={form} action={signOut} className={formClassName}>
      <button type="button" onClick={onClick} disabled={busy} className={className ?? 'text-sm text-ink-500 hover:text-ink-800'} data-testid="log-out">
        {busy ? 'Logging out…' : 'Log out'}
      </button>
      {error && <p role="alert" className="mt-1 max-w-64 text-xs font-medium text-red-700" data-testid="logout-blocked">{error}</p>}
    </form>
  );
}
