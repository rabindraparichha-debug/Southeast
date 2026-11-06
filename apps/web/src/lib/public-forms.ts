'use client';

import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabaseBrowser } from './supabase/client';

export type PublicFormAction = 'submit_lead' | 'lead_choose' | 'submit_vendor_application';

/**
 * The lead form, the kitchen pick and the vendor sign-up go through the public-forms Edge Function
 * (Turnstile CAPTCHA, per-IP limits, D-144); the database no longer lets anon call them directly.
 * Errors come back as { message: code } like an RPC error, for friendlyErrorIn('public', …).
 */
export async function publicForm<T>(action: PublicFormAction, args: Record<string, unknown>, captchaToken?: string | null)
  : Promise<{ data: T | null; error: { message: string } | null }> {
  const { data, error } = await supabaseBrowser().functions.invoke('public-forms', {
    body: { action, args, captcha_token: captchaToken ?? undefined },
  });
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const body = await (error.context as Response).json().catch(() => null) as { error?: string } | null;
      return { data: null, error: { message: body?.error ?? 'failed' } };
    }
    return { data: null, error: { message: error.message || 'network' } };
  }
  return { data: ((data as { data?: T } | null)?.data ?? null), error: null };
}
