import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Session } from '@supabase/supabase-js';
import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { MemberRole } from '@tiffin/db';
import { resetRider } from './rider-store';
import { loadServerOverride, supabase } from './supabase';

export type Membership = { kitchenId: string; kitchenName: string; role: MemberRole };

type AuthState = {
  ready: boolean;
  session: Session | null;
  memberships: Membership[];
  kitchen: Membership | null;
  selectKitchen: (kitchenId: string) => Promise<void>;
  reload: () => Promise<void>;
  signOut: () => Promise<void>;
};

const KITCHEN_KEY = 'tiffin.kitchenId';
const MEMBERSHIPS_KEY = 'tiffin.memberships'; // so riders can open the app without network
const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [kitchenId, setKitchenId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const loadMemberships = useCallback(async (s: Session | null) => {
    if (!s) {
      setMemberships([]);
      return;
    }
    // Staff/riders invited before their first login join their kitchen now.
    await supabase.rpc('claim_invites');
    const { data, error } = await supabase.from('members').select('role, kitchen:kitchens(id, name)').eq('user_id', s.user.id);
    if (error) {
      const cached = await AsyncStorage.getItem(MEMBERSHIPS_KEY);
      if (cached) setMemberships(JSON.parse(cached) as Membership[]);
      return;
    }
    const list = (data ?? [])
      .filter((m) => m.kitchen)
      .map((m) => ({ kitchenId: m.kitchen!.id, kitchenName: m.kitchen!.name, role: m.role }))
      .sort((a, b) => a.kitchenName.localeCompare(b.kitchenName));
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
        setSession(s);
        if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') void loadMemberships(s);
      });
      unsubscribe = () => sub.subscription.unsubscribe();
      const [{ data }, stored] = await Promise.all([supabase.auth.getSession(), AsyncStorage.getItem(KITCHEN_KEY)]);
      if (!alive) return;
      setKitchenId(stored);
      setSession(data.session);
      await loadMemberships(data.session);
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
        await supabase.auth.signOut();
        await AsyncStorage.multiRemove([KITCHEN_KEY, MEMBERSHIPS_KEY]);
        await resetRider();
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
