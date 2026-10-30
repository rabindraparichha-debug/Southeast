import Link from 'next/link';
import { formatPhone } from '@tiffin/core';
import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { Badge, Card, DIET_LABEL, DIET_TONE, LANGUAGE_LABEL, LinkButton, PageHeader } from '@/components/ui';

export default async function CustomersPage({ searchParams }: PageProps<'/customers'>) {
  const { kitchen } = await requireKitchen(['owner', 'staff']);
  const q = String((await searchParams).q ?? '').trim();
  const supabase = await createClient();
  const { data: customers, error } = await supabase.rpc('search_customers', { p_kitchen: kitchen.kitchenId, p_q: q, p_limit: 200 });
  const isOwner = kitchen.role === 'owner';

  return (
    <>
      <PageHeader
        title="Customers"
        subtitle={q ? `Results for “${q}”` : `${customers?.length ?? 0} customers`}
        actions={
          <>
            <LinkButton href="/customers/offices" variant="secondary">Offices</LinkButton>
            {isOwner && (
              <>
                <LinkButton href="/customers/import" variant="secondary">Import</LinkButton>
                <LinkButton href="/customers/new">Add customer</LinkButton>
              </>
            )}
          </>
        }
      />
      <form className="mb-4 flex gap-2">
        <input
          name="q"
          defaultValue={q}
          type="search"
          placeholder={isOwner ? 'Name, full phone, last 4 digits, area or landmark' : 'Name, last 4 digits, area or landmark'}
          className="w-full max-w-md rounded-lg border-0 px-3 py-2 text-sm ring-1 ring-ink-200 focus:ring-2 focus:ring-brand-500"
        />
      </form>
      {error && <p className="text-sm text-red-700">{error.message}</p>}
      <Card className="overflow-x-auto p-0">
        <table className="min-w-full text-sm">
          <thead className="border-b border-ink-100 text-left text-xs uppercase text-ink-500">
            <tr>
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Phone</th>
              <th className="px-4 py-3 font-medium">Address</th>
              <th className="px-4 py-3 font-medium">Diet</th>
              <th className="hidden px-4 py-3 font-medium sm:table-cell">Language</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {(customers ?? []).map((c) => (
              <tr key={c.id} className="hover:bg-ink-50">
                <td className="px-4 py-3 font-medium">
                  <Link href={`/customers/${c.id}`} className="hover:text-brand-700">{c.name}</Link>
                  {c.platform_sourced && <span className="ml-2"><Badge tone="blue">Platform</Badge></span>}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-ink-600">{formatPhone(c.phone)}</td>
                <td className="px-4 py-3 text-ink-600">
                  {[c.line1, c.landmark, c.area].filter(Boolean).join(', ') || <span className="text-ink-400">No address</span>}
                </td>
                <td className="px-4 py-3">{c.diet && <Badge tone={DIET_TONE[c.diet]}>{DIET_LABEL[c.diet]}</Badge>}</td>
                <td className="hidden px-4 py-3 text-ink-600 sm:table-cell">{c.preferred_language && LANGUAGE_LABEL[c.preferred_language]}</td>
              </tr>
            ))}
            {customers?.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-ink-500">
                  {q ? 'No customers match.' : 'No customers yet. Add one or import your register from Excel.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </>
  );
}
