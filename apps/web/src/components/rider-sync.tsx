'use client';

import { useEffect } from 'react';
import { startRiderSync } from '@/lib/rider-store';

/** Sends rider actions saved on this device from any page (and on reconnect), not only rider mode. */
export function RiderSync({ userId }: { userId: string }) {
  useEffect(() => startRiderSync(userId), [userId]);
  return null;
}
