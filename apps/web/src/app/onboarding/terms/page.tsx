import { redirect } from 'next/navigation';
import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { VendorTermsAccept } from '@/components/vendor-terms-accept';

// The kitchen owner accepts the current vendor terms and data processing agreement (D-142) once,
// before using the dashboard; asked again whenever their version changes.
export default async function TermsPage() {
  const { kitchen } = await requireKitchen(['owner']);
  const supabase = await createClient();
  const { data } = await supabase.rpc('vendor_terms_status', { p_kitchen: kitchen.kitchenId });
  if ((data as { accepted?: boolean } | null)?.accepted) redirect('/');
  return (
    <main className="mx-auto max-w-lg px-4 py-12">
      <h1 className="text-xl font-semibold">Before you continue</h1>
      <p className="mt-1 text-sm text-ink-500">
        {kitchen.kitchenName} uses Tiffin software to keep its customers’ details. Please read and accept our vendor terms and the data
        processing agreement (how we look after your customers’ data for you). Both are drafts until a lawyer has reviewed them.
      </p>
      <div className="mt-6 rounded-xl bg-white p-6 shadow-sm ring-1 ring-ink-100">
        <VendorTermsAccept kitchenId={kitchen.kitchenId} />
      </div>
    </main>
  );
}
