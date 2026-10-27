'use client';
import { createBrowserClient } from '@supabase/ssr';
import type { Database } from '@tiffin/db';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './env';

let client: ReturnType<typeof createBrowserClient<Database>> | undefined;

/** Browser client (singleton). Same RPCs and RLS as the mobile app. */
export function supabaseBrowser() {
  client ??= createBrowserClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY);
  return client;
}
