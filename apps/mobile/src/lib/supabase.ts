import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import Constants from 'expo-constants';
import { AppState, Platform } from 'react-native';
import type { Database } from '@tiffin/db';
import { ALLOW_SERVER_SWITCH, SUPABASE_ANON_KEY, SUPABASE_URL } from './env';

/** The app version, sent with every request as x-app-version (e.g. for a minimum-version check). */
export const APP_VERSION = Constants.expoConfig?.version ?? '0.0.0';

// Every request gives up after a while, so a weak signal never leaves a screen or the rider queue
// waiting forever (a timed-out rider action stays queued and is retried).
const TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 120_000; // a proof photo on a slow 2G/3G link
const FUNCTION_TIMEOUT_MS = 60_000;

const timeoutFetch: typeof fetch = (input, init) => {
  const url = typeof input === 'string' ? input : String((input as { url?: string }).url ?? input);
  const ms = url.includes('/storage/v1/object/') ? UPLOAD_TIMEOUT_MS : url.includes('/functions/v1/') ? FUNCTION_TIMEOUT_MS : TIMEOUT_MS;
  const controller = new AbortController();
  const outer = init?.signal;
  if (outer?.aborted) controller.abort();
  else outer?.addEventListener?.('abort', () => controller.abort());
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
};

/** Where supabase-js keeps the session (its own default key, written out so we can read it offline). */
const storageKeyFor = (url: string) => `sb-${new URL(url).hostname.split('.')[0]}-auth-token`;

const make = (url: string, key: string) =>
  createClient<Database>(url, key, {
    auth: {
      storage: AsyncStorage, storageKey: storageKeyFor(url), autoRefreshToken: true, persistSession: true,
      detectSessionInUrl: false,
    },
    global: {
      fetch: timeoutFetch,
      // Native only: a browser (Expo web, development) would need a CORS rule for the header.
      headers: Platform.OS === 'web' ? {} : { 'x-app-version': APP_VERSION },
    },
  });

// A build without a baked-in server still opens (test builds then pick one on the login screen).
let clientUrl = SUPABASE_URL || 'http://127.0.0.1:54321';
let client = make(clientUrl, SUPABASE_ANON_KEY || 'not-set');

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
      clientUrl = cfg.url;
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

/**
 * The saved session as it is, even when its access token has expired. supabase-js reports no session
 * when it cannot refresh an expired token for lack of network (it keeps it saved and refreshes it
 * once the network is back); the app then stays signed in on cached data instead of showing login.
 */
export async function readStoredSession(): Promise<Session | null> {
  try {
    const raw = await AsyncStorage.getItem(storageKeyFor(clientUrl));
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    return s?.access_token && s.refresh_token && s.user?.id ? s : null;
  } catch {
    return null;
  }
}

// Refresh tokens only while the app is in the foreground.
if (Platform.OS !== 'web') {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') supabase.auth.startAutoRefresh();
    else supabase.auth.stopAutoRefresh();
  });
}
