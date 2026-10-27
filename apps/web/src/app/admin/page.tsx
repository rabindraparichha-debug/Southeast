import Link from 'next/link';
import { requireAdmin } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { Badge, Card, PageHeader } from '@/components/ui';
import { StatusButtons } from './status-buttons';

// Admin console (M8 builds the full version: onboarding/KYC, lead routing, funnel).
export default async function AdminPage() {
  const session = await requireAdmin();
  const supabase = await createClient();
  const { data: kitchens } = await supabase
    .from('kitchens')
    .select('id, name, area, fssai_no, status, created_at, customers(count)')
    .order('created_at', { ascending: false });

  return (
    <main className="mx-auto max-w-5xl p-4 md:p-8">
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
                <td className="px-4 py-3">{k.customers?.[0]?.count ?? 0}</td>
                <td className="px-4 py-3">{k.fssai_no ?? <Badge tone="amber">Missing</Badge>}</td>
                <td className="px-4 py-3">
                  <Badge tone={k.status === 'active' ? 'green' : k.status === 'suspended' ? 'red' : 'gray'}>
                    {k.status === 'active' ? 'Listed' : k.status === 'suspended' ? 'Suspended' : 'Private'}
                  </Badge>
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
