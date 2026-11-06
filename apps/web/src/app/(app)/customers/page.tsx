import Link from 'next/link';
import { formatPhone, normalizePhone } from '@tiffin/core';
import { requireKitchen } from '@/lib/session';
import { CUSTOMER_ROLES, canReadMoney, isLead } from '@/lib/roles';
import { BILLING_SHORT, BILLING_TONE } from '@/lib/money';
import { createClient } from '@/lib/supabase/server';
import { Alert, Badge, Card, DIET_LABEL, DIET_TONE, LANGUAGE_LABEL, LinkButton, PageHeader } from '@/components/ui';

export default async function CustomersPage({ searchParams }: PageProps<'/customers'>) {
  const { kitchen } = await requireKitchen(CUSTOMER_ROLES);
  const q = String((await searchParams).q ?? '').trim();
  const supabase = await createClient();
  const { data: customers, error } = await supabase.rpc('search_customers', { p_kitchen: kitchen.kitchenId, p_q: q, p_limit: 200 });
  // Owner and manager: full phones, add and import. Accountant: names, masked phones and billing mode
  // (no addresses). Staff: names and areas only.
  const isOwner = isLead(kitchen.role);
  const money = canReadMoney(kitchen.role);
  const showAddress = kitchen.role !== 'accountant';
  // D-118: several customers may share one phone (siblings, a family phone); a phone search lists all.
  const sharedPhone = isOwner && Boolean(normalizePhone(q)) && (customers?.length ?? 0) > 1;
  const cols = 3 + (showAddress ? 1 : 0) + (money ? 1 : 0) + 1;

  return (
    <>
      <PageHeader
        title="Customers"
        subtitle={q ? `Results for “${q}”` : `${customers?.length ?? 0} customers`}
        actions={
          <>
            {showAddress && <LinkButton href="/customers/offices" variant="secondary">Offices</LinkButton>}
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
      {sharedPhone && (
        <div className="mb-4">
          <Alert tone="amber">{customers!.length} customers share this phone number. Check the name before recording anything.</Alert>
        </div>
      )}
      <Card className="overflow-x-auto p-0">
        <table className="min-w-full text-sm">
          <thead className="border-b border-ink-100 text-left text-xs uppercase text-ink-500">
            <tr>
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Phone</th>
              {showAddress && <th className="px-4 py-3 font-medium">Address</th>}
              {money && <th className="px-4 py-3 font-medium">Billing</th>}
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
                {showAddress && (
                  <td className="px-4 py-3 text-ink-600">
                    {[c.line1, c.landmark, c.area].filter(Boolean).join(', ') || <span className="text-ink-400">No address</span>}
                  </td>
                )}
                {money && <td className="px-4 py-3">{c.billing_mode && <Badge tone={BILLING_TONE[c.billing_mode]}>{BILLING_SHORT[c.billing_mode]}</Badge>}</td>}
                <td className="px-4 py-3">{c.diet && <Badge tone={DIET_TONE[c.diet]}>{DIET_LABEL[c.diet]}</Badge>}</td>
                <td className="hidden px-4 py-3 text-ink-600 sm:table-cell">{c.preferred_language && LANGUAGE_LABEL[c.preferred_language]}</td>
              </tr>
            ))}
            {customers?.length === 0 && (
              <tr>
                <td colSpan={cols} className="px-4 py-10 text-center text-ink-500">
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
