import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Session } from '@supabase/supabase-js';
import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { MemberRole } from '@tiffin/db';
import { supabase } from './supabase';

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
    const { data } = await supabase.from('members').select('role, kitchen:kitchens(id, name)').eq('user_id', s.user.id);
    setMemberships(
      (data ?? [])
        .filter((m) => m.kitchen)
        .map((m) => ({ kitchenId: m.kitchen!.id, kitchenName: m.kitchen!.name, role: m.role }))
        .sort((a, b) => a.kitchenName.localeCompare(b.kitchenName)),
    );
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [{ data }, stored] = await Promise.all([supabase.auth.getSession(), AsyncStorage.getItem(KITCHEN_KEY)]);
      if (!alive) return;
      setKitchenId(stored);
      setSession(data.session);
      await loadMemberships(data.session);
      if (alive) setReady(true);
    })();
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') void loadMemberships(s);
    });
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
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
        await AsyncStorage.removeItem(KITCHEN_KEY);
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
