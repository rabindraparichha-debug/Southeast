import { execSync } from 'node:child_process';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@tiffin/db';

export const KITCHEN_A = '10000000-0000-4000-a000-00000000000a';
export const KITCHEN_B = '10000000-0000-4000-a000-00000000000b';
export const TEST_OTP = '123456';

type Env = { url: string; anonKey: string };
let cached: Env | undefined;

/** Reads the local stack's URL and anon key (or SUPABASE_URL / SUPABASE_ANON_KEY if set). */
export function env(): Env {
  if (cached) return cached;
  if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    cached = { url: process.env.SUPABASE_URL, anonKey: process.env.SUPABASE_ANON_KEY };
    return cached;
  }
  const out = execSync('npx supabase status -o json', { cwd: new URL('../..', import.meta.url).pathname });
  const json = JSON.parse(out.toString().slice(out.toString().indexOf('{')));
  cached = { url: json.API_URL, anonKey: json.ANON_KEY };
  return cached;
}

export type Client = SupabaseClient<Database>;

export function anonClient(): Client {
  const { url, anonKey } = env();
  return createClient<Database>(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Logs in with phone OTP exactly like the apps do (test OTP numbers from config.toml). */
export async function loginAs(phone: string): Promise<{ client: Client; accessToken: string; userId: string }> {
  const client = anonClient();
  for (let attempt = 0; ; attempt++) {
    const { error } = await client.auth.signInWithOtp({ phone });
    if (!error) break;
    // GoTrue enforces a short gap between OTP requests for the same phone.
    if (attempt < 3 && /after \d+ seconds|rate limit/i.test(error.message)) {
      await new Promise((r) => setTimeout(r, 6000));
      continue;
    }
    throw error;
  }
  const { data, error } = await client.auth.verifyOtp({ phone, token: TEST_OTP, type: 'sms' });
  if (error || !data.session) throw error ?? new Error('no session');
  return { client, accessToken: data.session.access_token, userId: data.session.user.id };
}

/** Raw PostgREST call, bypassing supabase-js, to prove isolation holds "via the API directly". */
export async function rest(path: string, accessToken: string, init: RequestInit = {}) {
  const { url, anonKey } = env();
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
