import Link from 'next/link';
import { formatPhone } from '@tiffin/core';
import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { STATUS_FILTERS, findCustomers, parseStatus, statusSummary, type StatusFilter } from '@/lib/customer-search';
import { Badge, Card, DIET_LABEL, DIET_TONE, LANGUAGE_LABEL, LinkButton, PageHeader, STATUS_LABEL, STATUS_TONE } from '@/components/ui';

const PAGE_SIZE = 50;

export default async function CustomersPage({ searchParams }: PageProps<'/customers'>) {
  const { kitchen } = await requireKitchen(['owner', 'staff']);
  const sp = await searchParams;
  const q = String(sp.q ?? '').trim();
  const isOwner = kitchen.role === 'owner';
  const status = isOwner ? parseStatus(sp.status) : 'all';
  const pageSize = Math.min(200, Math.max(10, Number(sp.per) || PAGE_SIZE));
  const supabase = await createClient();
  const { rows: customers, total, page, error } = await findCustomers(supabase, {
    kitchenId: kitchen.kitchenId, q, isOwner, status, page: Math.max(1, Math.floor(Number(sp.page) || 1)), pageSize,
  });
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);

  const href = (p: { page?: number; status?: StatusFilter }) => {
    const u = new URLSearchParams();
    if (q) u.set('q', q);
    const st = p.status ?? status;
    if (st !== 'all') u.set('status', st);
    if (sp.per) u.set('per', String(pageSize));
    if ((p.page ?? 1) > 1) u.set('page', String(p.page));
    const s = u.toString();
    return s ? `/customers?${s}` : '/customers';
  };
  const filterLabel = STATUS_FILTERS.find(([k]) => k === status)?.[1];

  return (
    <>
      <PageHeader
        title="Customers"
        subtitle={
          q
            ? `${total} result${total === 1 ? '' : 's'} for “${q}”${status !== 'all' ? ` · ${filterLabel}` : ''}`
            : `${total} customer${total === 1 ? '' : 's'}${status !== 'all' ? ` · ${filterLabel}` : ''}`
        }
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
      <form className="mb-3 flex gap-2">
        <input
          name="q"
          defaultValue={q}
          type="search"
          placeholder={isOwner ? 'Name, flat, area, landmark, full phone or last digits' : 'Name, flat, area, landmark or last 4 digits'}
          className="w-full max-w-md rounded-lg border-0 px-3 py-2 text-sm ring-1 ring-ink-200 focus:ring-2 focus:ring-brand-500"
        />
        {status !== 'all' && <input type="hidden" name="status" value={status} />}
      </form>
      {isOwner && (
        <nav aria-label="Filter by status" className="mb-4 flex flex-wrap gap-1.5" data-testid="status-filters">
          {STATUS_FILTERS.map(([key, label]) => (
            <Link
              key={key}
              href={href({ status: key, page: 1 })}
              aria-current={status === key ? 'page' : undefined}
              className={`rounded-full px-3 py-1 text-sm ring-1 ${status === key ? 'bg-ink-800 text-white ring-ink-800' : 'bg-white text-ink-700 ring-ink-200 hover:bg-ink-50'}`}
            >
              {label}
            </Link>
          ))}
        </nav>
      )}
      {error && <p className="text-sm text-red-700">{error}</p>}
      <Card className="overflow-x-auto p-0">
        <table className="min-w-full text-sm">
          <thead className="border-b border-ink-100 text-left text-xs uppercase text-ink-500">
            <tr>
              <th className="px-4 py-3 font-medium">Name</th>
              {isOwner && <th className="px-4 py-3 font-medium">Status</th>}
              <th className="px-4 py-3 font-medium">Phone</th>
              <th className="px-4 py-3 font-medium">Address</th>
              <th className="px-4 py-3 font-medium">Diet</th>
              <th className="hidden px-4 py-3 font-medium sm:table-cell">Language</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {customers.map((c) => {
              const st = c.statuses ? statusSummary(c.statuses) : null;
              return (
                <tr key={c.id} className="hover:bg-ink-50">
                  <td className="px-4 py-3 font-medium">
                    <Link href={`/customers/${c.id}`} className="hover:text-brand-700">{c.name}</Link>
                    {c.platform_sourced && <span className="ml-2"><Badge tone="blue">Platform</Badge></span>}
                  </td>
                  {isOwner && (
                    <td className="whitespace-nowrap px-4 py-3">
                      {st && (st === 'none' ? <span className="text-ink-400">No plan</span> : <Badge tone={STATUS_TONE[st]}>{STATUS_LABEL[st]}</Badge>)}
                    </td>
                  )}
                  <td className="whitespace-nowrap px-4 py-3 text-ink-600">{formatPhone(c.phone)}</td>
                  <td className="px-4 py-3 text-ink-600">
                    {[c.line1, c.landmark, c.area].filter(Boolean).join(', ') || <span className="text-ink-400">No address</span>}
                  </td>
                  <td className="px-4 py-3">{c.diet && <Badge tone={DIET_TONE[c.diet]}>{DIET_LABEL[c.diet]}</Badge>}</td>
                  <td className="hidden px-4 py-3 text-ink-600 sm:table-cell">{c.preferred_language && LANGUAGE_LABEL[c.preferred_language]}</td>
                </tr>
              );
            })}
            {customers.length === 0 && (
              <tr>
                <td colSpan={isOwner ? 6 : 5} className="px-4 py-10 text-center text-ink-500">
                  {q || status !== 'all' ? 'No customers match.' : 'No customers yet. Add one or import your register from Excel.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
      {total > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-ink-600" data-testid="customer-paging">
          <span>Showing {first}–{last} of {total}</span>
          {pages > 1 && (
            <span className="flex items-center gap-2">
              {page > 1 ? <Link href={href({ page: page - 1 })} className="rounded-lg px-3 py-1.5 ring-1 ring-ink-200 hover:bg-ink-50">← Previous</Link> : null}
              <span>Page {page} of {pages}</span>
              {page < pages ? <Link href={href({ page: page + 1 })} className="rounded-lg px-3 py-1.5 ring-1 ring-ink-200 hover:bg-ink-50">Next →</Link> : null}
            </span>
          )}
        </div>
      )}
    </>
  );
}
