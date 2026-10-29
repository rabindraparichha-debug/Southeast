// Shapes of the public (anon) acquisition RPCs (M7) and small helpers shared by the public pages.
import type { Enums } from '@tiffin/db';
import { SUPABASE_URL } from './supabase/env';

export type LeadSource = Enums<'lead_source'>;
export type LeadStatus = Enums<'lead_status'>;
export type VendorAppStatus = Enums<'vendor_app_status'>;

/** One card of the shortlist returned by submit_lead. */
export type ShortlistKitchen = {
  kitchen_id: string;
  name: string;
  slug: string;
  area: string | null;
  distance_km: number;
  plan_id: string;
  plan_name: string;
  price_per_meal_paise: number;
  rating: number | null;
  reviews: number;
  trial_meals: number;
  fssai_no: string | null;
  profile_url: string;
};

export type SubmitLeadResult = { token: string; status: LeadStatus; area: string | null; kitchens: ShortlistKitchen[] };

export type LeadChoice = {
  customer_id: string;
  kitchen_name: string;
  plan_name: string;
  trial_meals: number;
  price_per_meal_paise: number;
  trial_amount_paise: number;
  portal_token: string;
  portal_url: string;
};

export type KitchenProfile = {
  id: string;
  name: string;
  slug: string;
  area: string | null;
  city: string | null;
  description: string | null;
  cuisine_tags: string[];
  photo_paths: string[];
  fssai_no: string | null;
  service_radius_km: number;
  weekly_off: number[];
  trial_meals: number;
  accepting: boolean;
  rating: { avg: number | null; reviews: number } | null;
  plans: { id: string; name: string; slots: ('lunch' | 'dinner')[]; diet: Enums<'diet_type'>; days_of_week: number[]; price_per_meal_paise: number; description: string | null }[];
  menu: { date: string; slot: 'lunch' | 'dinner'; dishes: string[] }[];
  reviews: { rating: number; comment: string | null; name: string; date: string }[];
};

export type DirectoryKitchen = {
  name: string;
  slug: string;
  area: string | null;
  cuisine_tags: string[];
  photo: string | null;
  from_price_paise: number | null;
  rating: number | null;
  reviews: number;
  distance_km: number | null;
};

/** Public URL of a photo in the public `kitchen-photos` bucket (same as storage.getPublicUrl). */
export function photoUrl(path: string): string {
  return `${SUPABASE_URL}/storage/v1/object/public/kitchen-photos/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** "★ 4.3 (6 reviews)" or "New". */
export function ratingLabel(rating: number | null | undefined, reviews: number | null | undefined): string {
  if (!reviews || rating == null) return 'New';
  return `★ ${Number(rating).toFixed(1)} (${reviews} review${reviews === 1 ? '' : 's'})`;
}

/** Sources the website forms may send (submit_lead rejects the rest). */
const WEB_SOURCES: LeadSource[] = ['website', 'instagram', 'google_ads', 'referral', 'other'];
export function webSource(src: string | string[] | undefined): LeadSource {
  const s = (Array.isArray(src) ? src[0] : src)?.toLowerCase();
  return WEB_SOURCES.includes(s as LeadSource) ? (s as LeadSource) : 'website';
}

export function firstParam(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s?.trim() ? s.trim().slice(0, 60) : undefined;
}

export const SOURCE_LABEL: Record<LeadSource, string> = {
  whatsapp: 'WhatsApp', website: 'Website', google_ads: 'Google Ads', instagram: 'Instagram', justdial: 'Justdial',
  call: 'Call', referral: 'Referral', other: 'Other',
};

export const LEAD_STATUS_LABEL: Record<LeadStatus, string> = {
  new: 'New', qualifying: 'Qualifying', qualified: 'Qualified', matched: 'Matched', trial: 'Trial', converted: 'On a plan',
  renewed: 'Renewed', waitlist: 'Waitlist', lost: 'Lost',
};
export const LEAD_STATUS_TONE: Record<LeadStatus, 'gray' | 'green' | 'amber' | 'red' | 'blue'> = {
  new: 'gray', qualifying: 'gray', qualified: 'blue', matched: 'blue', trial: 'amber', converted: 'green', renewed: 'green',
  waitlist: 'amber', lost: 'red',
};

export const VENDOR_STATUS_LABEL: Record<VendorAppStatus, string> = {
  new: 'New', contacted: 'Contacted', onboarding: 'Onboarding', live: 'Live', rejected: 'Rejected',
};
export const VENDOR_STATUS_TONE: Record<VendorAppStatus, 'gray' | 'green' | 'amber' | 'red' | 'blue'> = {
  new: 'blue', contacted: 'gray', onboarding: 'amber', live: 'green', rejected: 'red',
};

/** Budget choices on the lead form: the midpoint of each band is sent as the target price. */
export const BUDGETS = [
  { value: '', label: 'No preference', paise: null },
  { value: 'lt60', label: 'Up to ₹60', paise: 5000 },
  { value: '60-80', label: '₹60–80', paise: 7000 },
  { value: '80-100', label: '₹80–100', paise: 9000 },
  { value: 'gt100', label: '₹100+', paise: 11000 },
] as const;

/** A timestamptz -> "3 Nov, 9:05 pm" in IST. */
export function istDateTime(at: string): string {
  return new Date(at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}
