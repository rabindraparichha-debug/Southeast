import Link from 'next/link';
import { requireAdmin } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { Badge, Card, PageHeader } from '@/components/ui';
import { StatusButtons } from './status-buttons';
import { PayoutForm } from './payout-form';

// Admin console (M8 builds the full version: onboarding/KYC, lead routing, funnel).
export default async function AdminPage() {
  const session = await requireAdmin();
  const supabase = await createClient();
  const { data: kitchens } = await supabase
    .from('kitchens')
    .select('id, name, area, fssai_no, status, created_at, kitchen_payout_accounts(razorpay_linked_account_id, kyc_status)')
    .order('created_at', { ascending: false });
  // Count through customers_v: the customers table itself is not selectable as a whole (phone columns).
  const { data: custRows } = await supabase.from('customers_v').select('kitchen_id');
  const counts = new Map<string, number>();
  (custRows ?? []).forEach((c) => counts.set(c.kitchen_id!, (counts.get(c.kitchen_id!) ?? 0) + 1));

  return (
    <main className="mx-auto max-w-6xl p-4 md:p-8">
      <PageHeader
        title="Admin · Kitchens"
        subtitle="Every admin action is written to the audit log."
        actions={session.kitchen && <Link href="/" className="text-sm text-brand-700 hover:underline">Back to my kitchen</Link>}
      />
      <Card className="overflow-x-auto p-0">
        <table className="min-w-full text-sm">
          <thead className="border-b border-ink-100 text-left text-xs uppercase text-ink-500">
            <tr>
              <th className="px-4 py-3">Kitchen</th>
              <th className="px-4 py-3">Customers</th>
              <th className="px-4 py-3">FSSAI</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Razorpay payout account</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {(kitchens ?? []).map((k) => (
              <tr key={k.id}>
                <td className="px-4 py-3">
                  <div className="font-medium">{k.name}</div>
                  <div className="text-ink-500">{k.area}</div>
                </td>
                <td className="px-4 py-3">{counts.get(k.id) ?? 0}</td>
                <td className="px-4 py-3">{k.fssai_no ?? <Badge tone="amber">Missing</Badge>}</td>
                <td className="px-4 py-3">
                  <Badge tone={k.status === 'active' ? 'green' : k.status === 'suspended' ? 'red' : 'gray'}>
                    {k.status === 'active' ? 'Listed' : k.status === 'suspended' ? 'Suspended' : 'Private'}
                  </Badge>
                </td>
                <td className="px-4 py-3">
                  <PayoutForm kitchenId={k.id} accountId={k.kitchen_payout_accounts?.razorpay_linked_account_id ?? null} kycStatus={k.kitchen_payout_accounts?.kyc_status ?? 'not_started'} />
                </td>
                <td className="px-4 py-3"><StatusButtons kitchenId={k.id} status={k.status} hasFssai={Boolean(k.fssai_no)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </main>
  );
}
