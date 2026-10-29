'use client';

import './globals.css';
import { ErrorScreen } from '@/components/error-screen';

// Replaces the root layout when it fails, so it brings its own <html>, <body> and styles.
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full font-sans">
        <title>Something went wrong · Tiffin</title>
        <ErrorScreen error={error} retry={retry} source="global-boundary" />
      </body>
    </html>
  );
}
