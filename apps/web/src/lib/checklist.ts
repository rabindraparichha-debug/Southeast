// Onboarding checklist keys returned by kitchen_checklist (M7), with owner-facing labels and the
// page where each item is fixed.
export type ChecklistItem = { key: string; done: boolean };

export const CHECKLIST: Record<string, { label: string; hint: string; href: string }> = {
  profile: { label: 'Kitchen profile', hint: 'A short description (20+ characters) and at least one photo.', href: '/settings#listing' },
  location: { label: 'Kitchen location', hint: 'Drop a pin so nearby customers can find you.', href: '/settings' },
  fssai: { label: 'FSSAI number', hint: 'Required before your kitchen can be listed.', href: '/settings' },
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
