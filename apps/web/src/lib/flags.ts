import 'server-only';
import { cache } from 'react';
import { notFound } from 'next/navigation';
import { createClient } from './supabase/server';
import type { Flag, Flags } from './flag-keys';

export type { Flag, Flags } from './flag-keys';

/**
 * The platform's phase switches (public.feature_flags(), wave 3 / D-180), read once per request.
 * Works signed in or not. If the read fails, everything counts as off (fail closed).
 */
export const getFlags = cache(async (): Promise<Flags> => {
  const supabase = await createClient();
  const { data } = await supabase.rpc('feature_flags');
  const raw = (data ?? {}) as Partial<Record<Flag, boolean>>;
  return {
    customer_whatsapp: raw.customer_whatsapp === true,
    customer_portal: raw.customer_portal === true,
    online_payments: raw.online_payments === true,
    marketplace: raw.marketplace === true,
    growth: raw.growth === true,
    extras: raw.extras === true,
    kitchen_switching: raw.kitchen_switching === true,
  };
});

/** For pages that exist only when a phase is switched on: 404 otherwise. */
export async function requireFlag(flag: Flag): Promise<Flags> {
  const flags = await getFlags();
  if (!flags[flag]) notFound();
  return flags;
}
