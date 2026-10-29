import type { Metadata } from 'next';
import Link from 'next/link';
import { formatPaise } from '@tiffin/core';
import { requireAdmin } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { firstParam, istDateTime, LEAD_STATUS_LABEL, LEAD_STATUS_TONE, SOURCE_LABEL, type LeadSource, type LeadStatus } from '@/lib/public';
import { Alert, Badge, Card, DIET_LABEL, PageHeader } from '@/components/ui';
import { NewLeadForm } from './new-lead-form';
import type { AdminLeadRow } from './types';

export const metadata: Metadata = { title: 'Leads · Admin' };

const STATUSES = Object.keys(LEAD_STATUS_LABEL) as LeadStatus[];
const SOURCES = Object.keys(SOURCE_LABEL) as LeadSource[];
const SLOT_SHORT = { lunch: 'L', dinner: 'D' } as const;

export default async function LeadsPage({ searchParams }: PageProps<'/admin/leads'>) {
  await requireAdmin();
  const sp = await searchParams;
  const status = STATUSES.find((s) => s === firstParam(sp.status));
  const source = SOURCES.find((s) => s === firstParam(sp.source));
  const q = firstParam(sp.q);
  const supabase = await createClient();
  const [{ data, error }, { data: areas }] = await Promise.all([
    supabase.rpc('admin_leads', { p_status: status, p_source: source, p_search: q, p_limit: 200 }),
    supabase.rpc('list_areas'),
  ]);
  const leads = (Array.isArray(data) ? data : []) as unknown as AdminLeadRow[];
  const select = 'rounded-lg border-0 px-3 py-2 text-sm ring-1 ring-ink-200';

  return (
    <main className="mx-auto max-w-6xl p-4 md:p-8">
      <PageHeader title="Leads" subtitle="People looking for a tiffin, from every channel. Phone numbers are masked; reveals are logged." />
      <details className="mb-4 rounded-xl bg-white shadow-sm ring-1 ring-ink-100">
        <summary className="cursor-pointer px-5 py-3 text-sm font-medium text-brand-700">+ New lead (call or walk-in)</summary>
        <div className="border-t border-ink-100 p-5">
          <NewLeadForm areas={Array.isArray(areas) ? (areas as string[]) : []} />
        </div>
      </details>

      <form className="mb-4 flex flex-wrap items-end gap-2" action="/admin/leads">
        <select name="status" defaultValue={status ?? ''} className={select} aria-label="Status">
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{LEAD_STATUS_LABEL[s]}</option>)}
        </select>
        <select name="source" defaultValue={source ?? ''} className={select} aria-label="Source">
          <option value="">All sources</option>
          {SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
        </select>
        <input name="q" type="search" defaultValue={q ?? ''} placeholder="Name, area, campaign, last 4 digits" className={`${select} min-w-60`} />
        <button className="rounded-lg bg-white px-4 py-2 text-sm font-medium ring-1 ring-ink-200 hover:bg-ink-50">Filter</button>
        {(status || source || q) && <Link href="/admin/leads" className="px-2 py-2 text-sm text-ink-500 hover:underline">Clear</Link>}
      </form>

      {error && <Alert>{error.message}</Alert>}
      <Card className="overflow-x-auto p-0">
        <table className="min-w-full text-sm">
          <thead className="border-b border-ink-100 text-left text-xs uppercase text-ink-500">
            <tr>
              <th className="px-4 py-3">Lead</th>
              <th className="px-4 py-3">Source</th>
              <th className="px-4 py-3">Wants</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Kitchen</th>
              <th className="px-4 py-3">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {leads.map((l) => (
              <tr key={l.id} className="hover:bg-ink-50">
                <td className="px-4 py-3">
                  <Link href={`/admin/leads/${l.id}`} className="font-medium text-ink-900 hover:text-brand-700 hover:underline">{l.name || 'No name'}</Link>
                  <div className="text-ink-500">{l.phone}{l.area ? ` · ${l.area}` : ''}</div>
                </td>
                <td className="px-4 py-3">
                  {SOURCE_LABEL[l.source]}
                  {l.campaign && <div className="text-xs text-ink-500">{l.campaign}</div>}
                </td>
                <td className="px-4 py-3 text-ink-700">
                  {[l.slots?.map((s) => SLOT_SHORT[s]).join('+'), l.diet ? DIET_LABEL[l.diet] : null,
                    l.budget_per_meal_paise ? `~${formatPaise(l.budget_per_meal_paise)}` : null].filter(Boolean).join(' · ') || '—'}
                </td>
                <td className="px-4 py-3">
                  <Badge tone={LEAD_STATUS_TONE[l.status]}>{LEAD_STATUS_LABEL[l.status]}</Badge>
                  {l.status === 'lost' && l.lost_reason && <div className="text-xs text-ink-500">{l.lost_reason}</div>}
                </td>
                <td className="px-4 py-3 text-ink-700">{l.chosen_kitchen ?? (l.matches ? `${l.matches} matched` : '—')}</td>
                <td className="px-4 py-3 whitespace-nowrap text-ink-500">{istDateTime(l.created_at)}</td>
              </tr>
            ))}
            {!leads.length && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-ink-500">No leads match these filters.</td></tr>
            )}
          </tbody>
        </table>
      </Card>
    </main>
  );
}
