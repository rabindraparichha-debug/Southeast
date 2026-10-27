'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { KITCHEN_COOKIE, getSession } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';

/** Kitchen switcher: only kitchens the user belongs to can be selected. */
export async function selectKitchen(kitchenId: string) {
  const session = await getSession();
  if (!session.memberships.some((m) => m.kitchenId === kitchenId)) return;
  (await cookies()).set(KITCHEN_COOKIE, kitchenId, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 365 });
  redirect('/');
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  (await cookies()).delete(KITCHEN_COOKIE);
  redirect('/login');
}
