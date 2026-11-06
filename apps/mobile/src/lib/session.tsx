import AsyncStorage from '@react-native-async-storage/async-storage';
import { isAuthRetryableFetchError, type Session } from '@supabase/supabase-js';
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { MemberRole } from '@tiffin/db';
import { withTimeout } from './rider-queue';
import { flushReports, loadRider, pendingReportCount, resetRider, riderPendingCount, syncQueue } from './rider-store';
import { clearScreenCache } from './cache-storage';
import { unregisterPush } from './push';
import { loadServerOverride, readStoredSession, supabase } from './supabase';

export type Membership = { kitchenId: string; kitchenName: string; role: MemberRole };

type AuthState = {
  ready: boolean;
  session: Session | null;
  memberships: Membership[];
  kitchen: Membership | null;
  selectKitchen: (kitchenId: string) => Promise<void>;
  reload: () => Promise<void>;
  /** Logs out, unless rider actions are still on this phone (then false: nothing is wiped). */
  signOut: () => Promise<boolean>;
};

const KITCHEN_KEY = 'tiffin.kitchenId';
const MEMBERSHIPS_KEY = 'tiffin.memberships'; // so riders can open the app without network
const AuthContext = createContext<AuthState | null>(null);

async function cachedMemberships(): Promise<Membership[] | null> {
  try {
    const raw = await AsyncStorage.getItem(MEMBERSHIPS_KEY);
    const list = raw ? (JSON.parse(raw) as Membership[]) : null;
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [kitchenId, setKitchenId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  // Memberships shown from the phone's cache because the server could not be asked: ask again
  // when the login is refreshed (network back).
  const fromCache = useRef(false);

  const loadMemberships = useCallback(async (s: Session | null) => {
    if (!s) {
      fromCache.current = false;
      setMemberships([]);
      return;
    }
    const fallBackToCache = async () => {
      const cached = await cachedMemberships();
      if (cached) setMemberships(cached);
      fromCache.current = true;
    };
    // Without a live login the requests below would go out anonymously and see no memberships,
    // which would send a rider with unsynced deliveries to "Set up your kitchen".
    const { data: live } = await supabase.auth.getSession();
    if (!live.session) return fallBackToCache();
    // Staff/riders invited before their first login join their kitchen now.
    await supabase.rpc('claim_invites');
    const { data, error } = await supabase.from('members').select('role, kitchen:kitchens(id, name)').eq('user_id', s.user.id);
    if (error) return fallBackToCache();
    const list = (data ?? [])
      .filter((m) => m.kitchen)
      .map((m) => ({ kitchenId: m.kitchen!.id, kitchenName: m.kitchen!.name, role: m.role }))
      .sort((a, b) => a.kitchenName.localeCompare(b.kitchenName));
    fromCache.current = false;
    setMemberships(list);
    await AsyncStorage.setItem(MEMBERSHIPS_KEY, JSON.stringify(list));
  }, []);

  useEffect(() => {
    let alive = true;
    let unsubscribe = () => {};
    (async () => {
      // Pick the server first (test builds), then listen to that client.
      await loadServerOverride();
      if (!alive) return;
      const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
        // No usable session at start-up can just mean "offline with an expired token": the check
        // below decides, so it is not overwritten here.
        if (event === 'INITIAL_SESSION' && !s) return;
        setSession(s);
        if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') void loadMemberships(s);
        if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') {
          if (event === 'TOKEN_REFRESHED' && fromCache.current) void loadMemberships(s);
          void syncQueue({ force: true }); // the network is back: send the rider's queued actions
        }
      });
      unsubscribe = () => sub.subscription.unsubscribe();
      const [{ data, error }, stored] = await Promise.all([supabase.auth.getSession(), AsyncStorage.getItem(KITCHEN_KEY)]);
      if (!alive) return;
      let s = data.session;
      // Offline with an expired access token: supabase-js keeps the session saved and refreshes it
      // when the network is back, so stay signed in on cached data meanwhile.
      if (!s && error && isAuthRetryableFetchError(error)) s = await readStoredSession();
      setKitchenId(stored);
      setSession(s);
      const cached = s ? await cachedMemberships() : null;
      if (cached?.length) {
        // Open at once with the saved kitchens; the server's answer replaces them in the background.
        setMemberships(cached);
        fromCache.current = true;
        if (alive) setReady(true);
        void loadMemberships(s);
        return;
      }
      await loadMemberships(s);
      if (alive) setReady(true);
    })();
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [loadMemberships]);

  const value = useMemo<AuthState>(() => {
    const kitchen = memberships.find((m) => m.kitchenId === kitchenId) ?? memberships[0] ?? null;
    return {
      ready,
      session,
      memberships,
      kitchen,
      selectKitchen: async (id) => {
        setKitchenId(id);
        await AsyncStorage.setItem(KITCHEN_KEY, id);
      },
      reload: () => loadMemberships(session),
      signOut: async () => {
        // Logging out wipes the phone's rider data: never while deliveries are still on it.
        await loadRider();
        if (riderPendingCount() > 0) {
          await syncQueue({ force: true });
          if (riderPendingCount() > 0) return false;
        }
        // Reports of refused actions (the owner's copy) go out first; wiping them would lose it.
        if ((await pendingReportCount()) > 0) {
          await withTimeout(flushReports(), 15_000).catch(() => undefined);
          if ((await pendingReportCount()) > 0) return false;
        }
        // Only once nothing is left to send: this phone stops getting the member's alerts (wave 3).
        await unregisterPush();
        await supabase.auth.signOut();
        await AsyncStorage.multiRemove([KITCHEN_KEY, MEMBERSHIPS_KEY]);
        await resetRider();
        await clearScreenCache(); // the offline copies of Today, customers and packing lists
        return true;
      },
    };
  }, [ready, session, memberships, kitchenId, loadMemberships]);

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth() {
  const ctx = use(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/** For screens that only render with a selected kitchen (guarded in the root layout). */
export function useKitchen() {
  const { kitchen } = useAuth();
  if (!kitchen) throw new Error('No kitchen selected');
  return kitchen;
}
