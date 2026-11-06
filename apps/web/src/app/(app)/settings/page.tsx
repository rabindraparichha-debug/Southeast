import { requireKitchen } from '@/lib/session';
import { getFlags } from '@/lib/flags';
import { createClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/ui';
import { SettingsForm } from './settings-form';
import { ListingForm } from './listing-form';
import { CareForm } from './care-form';

export default async function SettingsPage() {
  const { kitchen } = await requireKitchen(['owner']);
  const supabase = await createClient();
  const flags = await getFlags();
  const [{ data: k }, { data: s }, { data: payout }] = await Promise.all([
    supabase.from('kitchens').select('*').eq('id', kitchen.kitchenId).single(),
    supabase.from('kitchen_settings').select('*').eq('kitchen_id', kitchen.kitchenId).single(),
    supabase.from('kitchen_payout_accounts').select('kyc_status, razorpay_linked_account_id').eq('kitchen_id', kitchen.kitchenId).maybeSingle(),
  ]);
  if (!k || !s) return null;
  return (
    <>
      <PageHeader title="Kitchen settings" subtitle={`Status: ${k.status === 'active' ? 'Listed publicly' : k.status === 'suspended' ? 'Suspended' : 'Private (not listed)'}`} />
      {/* Verified (FSSAI checked by the platform) is separate from listed (D-147). */}
      <div className="mb-6 rounded-xl bg-white p-4 text-sm shadow-sm ring-1 ring-ink-100" data-testid="verification">
        <strong>FSSAI check:</strong>{' '}
        {k.verified_at
          ? `Checked by Tiffin on ${new Date(k.verified_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' })}. Being checked does not make your kitchen public.`
          : 'Not checked yet. Add your 14-digit FSSAI number below; our team checks the certificate once.'}
      </div>
      {flags.online_payments && (
        <div className="mb-6 rounded-xl bg-white p-4 text-sm shadow-sm ring-1 ring-ink-100">
          <strong>Online payments:</strong>{' '}
          {payout?.kyc_status === 'verified' && payout.razorpay_linked_account_id
            ? `On. Customer payments reach your bank through Razorpay (account ${payout.razorpay_linked_account_id}).`
            : `Not yet (${(payout?.kyc_status ?? 'not_started').replace('_', ' ')}). Our team sets up your Razorpay payout account with your PAN and bank details; until then record cash and UPI.`}
        </div>
      )}
      {/* Phase 2/3 settings appear only when the platform switches them on (D-141). */}
      {flags.marketplace && <ListingForm kitchen={k} />}
      <SettingsForm kitchen={k} settings={s} />
      {(flags.customer_whatsapp || flags.customer_portal) && <CareForm settings={s} />}
    </>
  );
}
