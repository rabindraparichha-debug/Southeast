'use client';

import { ErrorScreen } from '@/components/error-screen';

// Root error boundary: reports the error (when a DSN is set) and offers a retry.
export default function RootError({ error, retry }: { error: unknown; retry: () => void }) {
  return <ErrorScreen error={error} retry={retry} source="boundary" />;
}
