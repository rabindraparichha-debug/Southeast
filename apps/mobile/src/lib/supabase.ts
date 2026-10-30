import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AppState, Platform } from 'react-native';
import type { Database } from '@tiffin/db';
import { ALLOW_SERVER_SWITCH, SUPABASE_ANON_KEY, SUPABASE_URL } from './env';

const make = (url: string, key: string) =>
  createClient<Database>(url, key, {
    auth: { storage: AsyncStorage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false },
  });

let client = make(SUPABASE_URL, SUPABASE_ANON_KEY);

/** The app talks to whatever client is current (test builds can point at another server). */
export const supabase = new Proxy({} as SupabaseClient<Database>, {
  get(_target, prop) {
    const value = Reflect.get(client, prop, client);
    return typeof value === 'function' ? value.bind(client) : value;
  },
});

// Test builds only (EXPO_PUBLIC_ALLOW_SERVER_SWITCH=true): the server can be set on the login
// screen, e.g. a laptop running `pnpm db:start` on the same Wi-Fi, or a staging project.
const SERVER_KEY = 'tiffin.server';
export type ServerConfig = { url: string; anonKey: string };

export async function loadServerOverride(): Promise<ServerConfig> {
  if (ALLOW_SERVER_SWITCH) {
    const saved = await AsyncStorage.getItem(SERVER_KEY);
    if (saved) {
      const cfg = JSON.parse(saved) as ServerConfig;
      client = make(cfg.url, cfg.anonKey);
      return cfg;
    }
  }
  return { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY };
}

/** Saves a new server; the app must be restarted to use it (sessions belong to one server). */
export async function saveServerOverride(cfg: ServerConfig | null): Promise<void> {
  if (cfg) await AsyncStorage.setItem(SERVER_KEY, JSON.stringify(cfg));
  else await AsyncStorage.removeItem(SERVER_KEY);
}

// Refresh tokens only while the app is in the foreground.
if (Platform.OS !== 'web') {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') supabase.auth.startAutoRefresh();
    else supabase.auth.stopAutoRefresh();
  });
}
