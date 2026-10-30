'use client';

// Tiny IndexedDB key-value store for data that must survive a reload or a closed tab while offline
// (rider runs, the action queue, proof photos as bytes). Falls back to memory when IndexedDB is
// unavailable (some private windows); the app still works, it just forgets on reload.

const DB_NAME = 'tiffin-offline';
const STORE = 'kv';

let dbPromise: Promise<IDBDatabase | null> | null = null;
const memory = new Map<string, unknown>();

function openDb(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest | void): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    t.oncomplete = () => resolve(req ? (req.result as T) : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  if (!db) return memory.get(key) as T | undefined;
  return tx<T>(db, 'readonly', (s) => s.get(key));
}

export async function idbSet(entries: Record<string, unknown>): Promise<void> {
  const db = await openDb();
  if (!db) {
    Object.entries(entries).forEach(([k, v]) => memory.set(k, v));
    return;
  }
  await tx(db, 'readwrite', (s) => {
    Object.entries(entries).forEach(([k, v]) => s.put(v, k));
  });
}

export async function idbDelete(keys: string[]): Promise<void> {
  const db = await openDb();
  if (!db) {
    keys.forEach((k) => memory.delete(k));
    return;
  }
  await tx(db, 'readwrite', (s) => {
    keys.forEach((k) => s.delete(k));
  });
}

/** Keys starting with a prefix (e.g. every stored photo). */
export async function idbKeys(prefix: string): Promise<string[]> {
  const db = await openDb();
  const all = db ? ((await tx<IDBValidKey[]>(db, 'readonly', (s) => s.getAllKeys())) ?? []).map(String) : [...memory.keys()];
  return all.filter((k) => k.startsWith(prefix));
}
