// Phase switches (platform_settings, read through public.feature_flags()). Shared by server pages
// and client components (which get them as props). D-141 says which screens each one controls:
//   customer_whatsapp  inbox, WhatsApp card on a customer, care settings (with customer_portal)
//   customer_portal    /c/[token] customer page, "share page link"
//   online_payments    payment links (owner, customer page), Razorpay payout checklist item, commission
//   marketplace        /find, /kitchens, /k/[slug], public listing settings, leads and reviews (admin)
//   growth             /vendors sign-up, vendor applications and funnel (admin)
//   extras             insights, festival specials, complaint scores, referrals
//   kitchen_switching  customer-page kitchen switching (D-106)
export type Flag =
  | 'customer_whatsapp'
  | 'customer_portal'
  | 'online_payments'
  | 'marketplace'
  | 'growth'
  | 'extras'
  | 'kitchen_switching';

export type Flags = Record<Flag, boolean>;

export const FLAG_LABELS: Record<Flag, { label: string; hint: string }> = {
  customer_whatsapp: { label: 'Customer WhatsApp', hint: 'Messages to customers, leads and applicants; the kitchen inbox.' },
  customer_portal: { label: 'Customer page', hint: 'The /c/… page where customers skip, pause and see their balance.' },
  online_payments: { label: 'Online payments', hint: 'Razorpay payment links (needs a verified payout account per kitchen).' },
  marketplace: { label: 'Marketplace', hint: 'Public kitchen pages, /find lead form, matching and reviews.' },
  growth: { label: 'Growth', hint: 'Vendor sign-up page, vendor applications, growth nudges, ad conversions.' },
  extras: { label: 'Extras', hint: 'Insights, festival specials, complaint scores, referrals.' },
  kitchen_switching: { label: 'Kitchen switching', hint: 'Platform customers can ask to move to another kitchen (D-106).' },
};

export const ALL_OFF: Flags = {
  customer_whatsapp: false, customer_portal: false, online_payments: false, marketplace: false, growth: false, extras: false,
  kitchen_switching: false,
};
