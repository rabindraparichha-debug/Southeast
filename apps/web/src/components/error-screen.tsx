'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { reportError } from '@/lib/monitor';

// Shared by app/error.tsx and app/global-error.tsx. Server errors (they carry a digest) were already
// reported by instrumentation.ts, so only client-side errors are sent from here.
export function ErrorScreen({ error, retry, source }: { error: unknown; retry: () => void; source: string }) {
  const digest = typeof error === 'object' && error !== null && 'digest' in error ? String((error as { digest: unknown }).digest) : '';
  useEffect(() => {
    if (!digest) void reportError(error, { source, tags: { path: window.location.pathname } });
  }, [error, digest, source]);
  return (
    <main className="flex min-h-[60vh] items-center justify-center px-4 py-16 text-center">
      <div className="max-w-sm">
        <div className="text-4xl" aria-hidden>🍲</div>
        <h1 className="mt-3 text-lg font-semibold text-ink-900">Something went wrong</h1>
        <p className="mt-1 text-sm text-ink-500">
          Sorry, this page didn’t load. Please try again; if it keeps happening, tell us what you were doing.
        </p>
        {digest && <p className="mt-2 font-mono text-xs text-ink-400">Ref: {digest}</p>}
        <div className="mt-5 flex justify-center gap-2">
          <button type="button" onClick={() => retry()}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">Try again</button>
          <Link href="/" className="rounded-lg px-4 py-2 text-sm font-medium text-ink-700 ring-1 ring-ink-200 hover:bg-ink-50">Go home</Link>
        </div>
      </div>
    </main>
  );
}
