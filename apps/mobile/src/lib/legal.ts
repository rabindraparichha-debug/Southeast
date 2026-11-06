// Vendor terms and data processing agreement (D-181): the versions this app asks the owner to
// accept. Keep in sync with apps/web/src/lib/legal-versions.ts and private.vendor_terms_versions().
import { supabase } from './supabase';

export const VENDOR_TERMS_VERSION = '2026-11-draft-1';
export const DPA_VERSION = '2026-11-draft-1';

export function acceptVendorTerms(kitchenId: string) {
  return supabase.rpc('accept_vendor_terms', {
    p_kitchen: kitchenId, p_terms_version: VENDOR_TERMS_VERSION, p_dpa_version: DPA_VERSION, p_channel: 'app',
  });
}
