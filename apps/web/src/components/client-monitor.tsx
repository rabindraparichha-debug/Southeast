'use client';

import { useEffect } from 'react';
import { monitoringEnabled, reportError } from '@/lib/monitor';

// Reports uncaught browser errors and unhandled promise rejections (not caught by an error
// boundary) to Sentry. Mounted once in the root layout; does nothing without NEXT_PUBLIC_SENTRY_DSN.
const MAX_REPORTS_PER_PAGE = 10;

export function ClientMonitor() {
  useEffect(() => {
    if (!monitoringEnabled()) return;
    const seen = new Set<string>();
    const send = (error: unknown, kind: string) => {
      const key = `${kind}:${error instanceof Error ? error.message : String(error)}`;
      if (seen.has(key) || seen.size >= MAX_REPORTS_PER_PAGE) return;
      seen.add(key);
      void reportError(error, { source: 'window', tags: { kind, path: window.location.pathname } });
    };
    const onError = (e: ErrorEvent) => send(e.error ?? e.message, 'error');
    const onRejection = (e: PromiseRejectionEvent) => send(e.reason, 'unhandledrejection');
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);
  return null;
}
