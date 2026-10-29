'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { analyticsEnabled, trackPageview } from '@/lib/analytics';

// Page views for the public website. Renders nothing; does nothing without NEXT_PUBLIC_POSTHOG_KEY
// or when the visitor has Do Not Track / Global Privacy Control on.
export function AnalyticsProvider() {
  const pathname = usePathname();
  useEffect(() => {
    if (!pathname || !analyticsEnabled()) return;
    trackPageview(pathname + window.location.search);
  }, [pathname]);
  return null;
}
