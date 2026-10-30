// EXPO_PUBLIC_* values are inlined at build time. See apps/mobile/.env.example.
export const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
export const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
export const IS_DEV = __DEV__;
// Test builds: allow choosing the server on the login screen (never in store builds).
export const ALLOW_SERVER_SWITCH = process.env.EXPO_PUBLIC_ALLOW_SERVER_SWITCH === 'true';
