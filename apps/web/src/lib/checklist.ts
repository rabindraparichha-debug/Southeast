// Onboarding checklist keys returned by kitchen_checklist (M7), with owner-facing labels and the
// page where each item is fixed. Wave 3 (D-141, D-147): marketplace items show only once the
// marketplace is switched on, the payout item only with online payments, and "FSSAI checked by
// Tiffin" (verified, separate from listed) is added from kitchens.verified_at.
import type { Flags } from './flag-keys';

export type ChecklistItem = { key: string; done: boolean };

export const CHECKLIST: Record<string, { label: string; hint: string; href: string }> = {
  profile: { label: 'Kitchen profile', hint: 'A short description (20+ characters) and at least one photo.', href: '/settings#listing' },
  location: { label: 'Kitchen location', hint: 'Drop a pin so nearby customers can find you.', href: '/settings' },
  fssai: { label: 'FSSAI number', hint: '14 digits, from your FSSAI registration or licence.', href: '/settings' },
  verified: { label: 'FSSAI checked by Tiffin', hint: 'Our team checks your certificate once. Your kitchen stays private.', href: '/settings' },
  plans: { label: 'Plans and prices', hint: 'At least one active plan.', href: '/plans' },
  menu: { label: 'This week’s menu', hint: 'Publish the menu for the coming days.', href: '/menu' },
  payout: { label: 'Online payments', hint: 'Our team verifies your Razorpay payout account (PAN and bank).', href: '/settings' },
  customers: { label: 'Your customers', hint: 'Add or import at least 5 customers.', href: '/customers/import' },
  rider: { label: 'A rider', hint: 'Invite the person who delivers your tiffins.', href: '/team' },
  live: { label: 'Listed on the platform', hint: 'Our team lists your kitchen once FSSAI is in place.', href: '/settings' },
};

export function checklistItems(data: unknown): ChecklistItem[] {
  return Array.isArray(data) ? (data as ChecklistItem[]).filter((i) => i && typeof i.key === 'string') : [];
}

/** Keys that belong to a phase: hidden while that phase is off. */
const PHASE_ITEMS: Record<string, keyof Flags> = { profile: 'marketplace', live: 'marketplace', payout: 'online_payments' };

/** The checklist an owner sees: phase items filtered, the verification step added after FSSAI. */
export function phaseChecklist(items: ChecklistItem[], flags: Flags, verified: boolean): ChecklistItem[] {
  const out: ChecklistItem[] = [];
  for (const i of items) {
    const phase = PHASE_ITEMS[i.key];
    if (phase && !flags[phase]) continue;
    out.push(i);
    if (i.key === 'fssai') out.push({ key: 'verified', done: verified });
  }
  return out;
}
