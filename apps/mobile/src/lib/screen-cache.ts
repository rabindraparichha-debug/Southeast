// Offline copies of the vendor screens (Today, customers list, packing list). Pure helpers with no
// React Native imports, so tests/integration/mobile-screens.test.ts runs them from Node; the
// AsyncStorage side is cached-fetch.ts.
//
// Rules:
// - one copy per kitchen and screen (and per date/meal for the packing list), saved after every
//   successful load and shown only when a load fails (or while a slow one is still running);
// - a copy belongs to the user, kitchen and role that saved it: anyone else on the phone never
//   sees it;
// - copies saved by anyone but the owner never hold phone numbers (staff never see them);
// - copies older than a week are ignored, and logging out deletes them all.
import { classifyError, type ErrorLike } from './rider-queue';

export const CACHE_PREFIX = 'tiffin.cache.v1:';
export const CACHE_MAX_AGE_MS = 7 * 24 * 3600_000;

export type CacheScope = { userId: string; kitchenId: string; role: string };
export type CacheEntry<T> = { v: 1; userId: string; kitchenId: string; role: string; savedAt: string; data: T };

/** Why a screen shows the saved copy (null: live data). */
export type Stale = {
  /** When the copy shown was saved; null when there is no copy on the phone. */
  savedAt: string | null;
  /** True when the server could not be reached at all (no signal, timed out). */
  offline: boolean;
  /** The failure, already in vendor-facing words. */
  error: string;
  /** The copy is shown while a slow load is still running. */
  updating?: boolean;
};

export function cacheKey(scope: Pick<CacheScope, 'kitchenId'>, screen: string, part?: string): string {
  return `${CACHE_PREFIX}${scope.kitchenId}:${screen}${part ? `:${part}` : ''}`;
}

const PHONE_FIELD = /phone/i; // phone, phone_last4, phone_masked, payer_phone …

/** Removes every phone-number field, at any depth. */
export function stripPhones<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripPhones(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!PHONE_FIELD.test(k)) out[k] = stripPhones(v);
    }
    return out as T;
  }
  return value;
}

/** Owners and managers see full numbers (D-136); everyone else's copy never holds one. */
const keepsPhones = (role: string) => role === 'owner' || role === 'manager';

/** What is saved: only the owner's and manager's copies keep phone numbers. */
export function makeEntry<T>(scope: CacheScope, data: T, now: Date = new Date()): CacheEntry<T> {
  return {
    v: 1, userId: scope.userId, kitchenId: scope.kitchenId, role: scope.role, savedAt: now.toISOString(),
    data: keepsPhones(scope.role) ? data : stripPhones(data),
  };
}

/** The saved copy, if it is readable, belongs to this user, kitchen and role, and is recent enough. */
export function readEntry<T>(raw: string | null | undefined, scope: CacheScope, now: Date = new Date(),
                             maxAgeMs: number = CACHE_MAX_AGE_MS): CacheEntry<T> | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !('data' in parsed)) return null;
  const e = parsed as Partial<CacheEntry<T>>;
  if (e.v !== 1 || e.userId !== scope.userId || e.kitchenId !== scope.kitchenId || e.role !== scope.role) return null;
  const at = Date.parse(String(e.savedAt));
  if (!Number.isFinite(at) || now.getTime() - at > maxAgeMs) return null;
  // Belt and braces: a copy read by anyone but the owner or a manager never shows a phone number.
  return { ...(e as CacheEntry<T>), data: keepsPhones(scope.role) ? (e.data as T) : stripPhones(e.data as T) };
}

/** True when the request never reached the server (no signal or timed out), as in the rider queue. */
export function isOfflineError(e: ErrorLike | null | undefined): boolean {
  if (!e) return false;
  const v = classifyError(e);
  return v.kind === 'wait' && v.network;
}

/** A thrown value (fetch failure, timeout) as an error the screens understand. */
export function toErrorLike(e: unknown): ErrorLike {
  if (e && typeof e === 'object') {
    const x = e as { message?: unknown; name?: unknown; code?: unknown };
    return { message: String(x.message ?? 'network'), name: x.name ? String(x.name) : null, code: x.code ? String(x.code) : null };
  }
  return { message: String(e ?? 'network') };
}

/**
 * Saved packing lists to delete: those of this kitchen for dates before keepFrom (YYYY-MM-DD).
 * Keys look like `<prefix><kitchen>:sheet:<date>.<slot>`.
 */
export function oldSheetKeys(keys: readonly string[], kitchenId: string, keepFrom: string): string[] {
  const prefix = cacheKey({ kitchenId }, 'sheet') + ':';
  return keys.filter((k) => {
    if (!k.startsWith(prefix)) return false;
    const date = k.slice(prefix.length, prefix.length + 10);
    return !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < keepFrom;
  });
}

/** How many customers the list loads, so also the most the saved copy holds for offline search. */
export const CUSTOMER_LIST_LIMIT = 200;

/**
 * True when an offline search runs over a saved list that was cut off at the load limit, so a
 * customer past it is missing (the screen says so instead of a plain "no match").
 */
export function offlineSearchPartial(savedCount: number, query: string, limit: number = CUSTOMER_LIST_LIMIT): boolean {
  return query.trim() !== '' && savedCount >= limit;
}

type Searchable = {
  name?: string | null; line1?: string | null; area?: string | null; landmark?: string | null;
  phone?: string | null; phone_last4?: string | null;
};

/**
 * Offline search over the saved customer list: name, flat, area or landmark (and the number when
 * the copy has it, i.e. the owner's). Every word must match.
 */
export function filterCachedCustomers<T extends Searchable>(rows: readonly T[], q: string): T[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...rows];
  return rows.filter((r) => {
    const digits = (r.phone ?? '').replace(/\D/g, '');
    const hay = [r.name, r.line1, r.area, r.landmark, r.phone_last4, digits].filter(Boolean).join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
