import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { MemberRole } from '@tiffin/db';
import { createClient } from './supabase/server';

export const KITCHEN_COOKIE = 'kitchen_id';

export type Membership = { kitchenId: string; kitchenName: string; slug: string; role: MemberRole };

export type Session = {
  userId: string;
  phone: string | null;
  isAdmin: boolean;
  memberships: Membership[];
  /** The kitchen selected in the switcher (cookie), else the first membership. */
  kitchen: Membership | null;
};

/** Data access layer: the only place pages learn who the user is. Cached per request. */
export const getSession = cache(async (): Promise<Session> => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (!claims?.sub) redirect('/login');

  const [{ data: rows }, { data: admin }] = await Promise.all([
    supabase.from('members').select('role, kitchen:kitchens(id, name, slug)').eq('user_id', claims.sub),
    supabase.from('platform_admins').select('user_id').eq('user_id', claims.sub).maybeSingle(),
  ]);

  const memberships: Membership[] = (rows ?? [])
    .filter((r) => r.kitchen)
    .map((r) => ({ kitchenId: r.kitchen!.id, kitchenName: r.kitchen!.name, slug: r.kitchen!.slug, role: r.role }))
    .sort((a, b) => a.kitchenName.localeCompare(b.kitchenName));

  const selected = (await cookies()).get(KITCHEN_COOKIE)?.value;
  const kitchen = memberships.find((m) => m.kitchenId === selected) ?? memberships[0] ?? null;

  return {
    userId: claims.sub,
    phone: typeof claims.phone === 'string' ? claims.phone : null,
    isAdmin: Boolean(admin),
    memberships,
    kitchen,
  };
});

/** Requires a selected kitchen (and optionally one of the given roles). */
export async function requireKitchen(roles?: MemberRole[]) {
  const session = await getSession();
  if (!session.kitchen) redirect(session.isAdmin ? '/admin' : '/onboarding');
  if (roles && !roles.includes(session.kitchen.role)) redirect('/');
  return session as Session & { kitchen: Membership };
}

export async function requireAdmin() {
  const session = await getSession();
  if (!session.isAdmin) redirect('/');
  return session;
}
