import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requireKitchen } from '@/lib/session';
import { RiderApp } from './rider-app';

export const metadata: Metadata = { title: 'My stops · Tiffin OS' };

// Rider mode: riders land here after log-in; owners reach it from "Deliver" for runs they ride themselves.
export default async function RiderPage() {
  const session = await requireKitchen();
  const canRide = session.memberships.some((m) => m.role === 'rider' || m.role === 'owner');
  if (!canRide) redirect('/');
  return <RiderApp userId={session.userId} isOwner={session.kitchen.role === 'owner'} />;
}
