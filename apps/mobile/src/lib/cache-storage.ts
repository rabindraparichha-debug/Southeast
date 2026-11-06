// AsyncStorage side of the screen copies (rules in screen-cache.ts). No session import, so the
// session can clear the copies on logout without an import cycle.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CACHE_PREFIX, makeEntry, readEntry, type CacheEntry, type CacheScope } from './screen-cache';

export async function readCache<T>(key: string, scope: CacheScope): Promise<CacheEntry<T> | null> {
  try {
    return readEntry<T>(await AsyncStorage.getItem(key), scope);
  } catch {
    return null; // storage unreadable: behave as if nothing was saved
  }
}

export async function writeCache<T>(key: string, scope: CacheScope, data: T, prune?: (keys: readonly string[]) => string[]): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(makeEntry(scope, data)));
    if (prune) {
      const old = prune(await AsyncStorage.getAllKeys());
      if (old.length) await AsyncStorage.multiRemove(old);
    }
  } catch {
    // storage full or unavailable: the screen still works online
  }
}

/** Deletes every saved screen copy (on logout). */
export async function clearScreenCache(): Promise<void> {
  try {
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(CACHE_PREFIX));
    if (keys.length) await AsyncStorage.multiRemove(keys);
  } catch {
    // nothing to clear
  }
}
