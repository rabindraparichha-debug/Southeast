// The platform's phase switches (public.feature_flags(), wave 3 / D-141). Phase 1 runs with all of
// them off: the inbox tab, insights and specials cards and marketplace checklist items stay hidden
// until the platform switches them on. Read once per app start and on focus of the home screen;
// a failed read counts as all off (fail closed).
import { useEffect, useState } from 'react';
import { supabase } from './supabase';

export type Flag = 'customer_whatsapp' | 'customer_portal' | 'online_payments' | 'marketplace' | 'growth' | 'extras' | 'kitchen_switching';
export type Flags = Record<Flag, boolean>;

export const ALL_OFF: Flags = {
  customer_whatsapp: false, customer_portal: false, online_payments: false, marketplace: false, growth: false, extras: false,
  kitchen_switching: false,
};

let cached: Flags = ALL_OFF;
const listeners = new Set<(f: Flags) => void>();
let inflight: Promise<Flags> | null = null;

export function parseFlags(data: unknown): Flags {
  const raw = (data && typeof data === 'object' ? data : {}) as Partial<Record<Flag, unknown>>;
  const out = { ...ALL_OFF };
  for (const k of Object.keys(ALL_OFF) as Flag[]) out[k] = raw[k] === true;
  return out;
}

/** Reloads the flags (deduplicated) and tells every screen using them. */
export function refreshFlags(): Promise<Flags> {
  inflight ??= Promise.resolve(supabase.rpc('feature_flags'))
    .then(({ data, error }) => (error ? cached : parseFlags(data)), () => cached)
    .then((f) => {
      cached = f;
      listeners.forEach((l) => l(f));
      return f;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function useFlags(): Flags {
  const [flags, setFlags] = useState<Flags>(cached);
  useEffect(() => {
    listeners.add(setFlags);
    void refreshFlags();
    return () => {
      listeners.delete(setFlags);
    };
  }, []);
  return flags;
}

/** Checklist items that belong to a phase (hidden while it is off). */
const PHASE_ITEMS: Record<string, Flag> = { profile: 'marketplace', live: 'marketplace', payout: 'online_payments' };
export function visibleChecklistKey(key: string, flags: Flags): boolean {
  const phase = PHASE_ITEMS[key];
  return !phase || flags[phase];
}
