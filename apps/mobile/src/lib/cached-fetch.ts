// Loads a vendor screen's data and keeps the last good copy on the phone (AsyncStorage, per
// kitchen), so Today, the customer list and the packing list show that copy with an "offline"
// banner instead of an empty screen when there is no signal. The rules (who may read a copy, no
// phone numbers for staff) are in screen-cache.ts.
import { useMemo } from 'react';
import { readCache, writeCache } from './cache-storage';
import { friendlyError } from './errors';
import type { ErrorLike } from './rider-queue';
import { cacheKey, isOfflineError, toErrorLike, type CacheEntry, type CacheScope, type Stale } from './screen-cache';
import { useAuth } from './session';

export type { Stale } from './screen-cache';

/** A slow load shows the saved copy after this long (a fast one never flashes it). */
const EARLY_MS = 1200;

/** A failed load of a screen that keeps no copy on the phone, for StaleScreen (null: it worked). */
export function failedLoad(e: ErrorLike | null | undefined): Stale | null {
  if (!e) return null;
  return { savedAt: null, offline: isOfflineError(e), error: friendlyError({ message: e.message ?? undefined, code: e.code ?? undefined }) };
}

/** Who the copies belong to (null before login: nothing is saved or read). */
export function useCacheScope(): CacheScope | null {
  const { session, kitchen } = useAuth();
  const userId = session?.user.id;
  const kitchenId = kitchen?.kitchenId;
  const role = kitchen?.role;
  return useMemo(() => (userId && kitchenId && role ? { userId, kitchenId, role } : null), [userId, kitchenId, role]);
}

/**
 * Runs `fetch`. On success the result is saved (unless `save` is false) and returned with
 * stale = null. On failure the saved copy is returned (data null when there is none) with why.
 * `onCached` gets the saved copy early when the load is slow, so a weak signal shows something.
 */
export async function cachedFetch<T>(opts: {
  scope: CacheScope | null;
  screen: string;
  part?: string;
  save?: boolean;
  fetch: () => Promise<{ data: T; error: ErrorLike | null }>;
  onCached?: (data: T, savedAt: string) => void;
  prune?: (keys: readonly string[]) => string[];
}): Promise<{ data: T | null; stale: Stale | null }> {
  const { scope } = opts;
  const key = scope ? cacheKey(scope, opts.screen, opts.part) : null;
  const cached: Promise<CacheEntry<T> | null> = key && scope ? readCache<T>(key, scope) : Promise.resolve(null);
  let settled = false;
  const timer = opts.onCached
    ? setTimeout(() => {
        void cached.then((e) => {
          if (e && !settled) opts.onCached?.(e.data, e.savedAt);
        });
      }, EARLY_MS)
    : null;

  let res: { data: T; error: ErrorLike | null };
  try {
    res = await opts.fetch();
  } catch (e) {
    res = { data: null as T, error: toErrorLike(e) };
  }
  settled = true;
  if (timer) clearTimeout(timer);

  if (!res.error) {
    if (key && scope && opts.save !== false) void writeCache(key, scope, res.data, opts.prune);
    return { data: res.data, stale: null };
  }
  const entry = await cached;
  const error = friendlyError({ message: res.error.message ?? undefined, code: res.error.code ?? undefined });
  return {
    data: entry?.data ?? null,
    stale: { savedAt: entry?.savedAt ?? null, offline: isOfflineError(res.error), error },
  };
}
