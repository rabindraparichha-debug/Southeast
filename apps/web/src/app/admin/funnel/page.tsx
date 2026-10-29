import type { Metadata } from 'next';
import Link from 'next/link';
import { addDays, istDate, isIsoDate } from '@tiffin/core';
import { requireAdmin } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { firstParam, SOURCE_LABEL } from '@/lib/public';
import { Alert, Card, PageHeader } from '@/components/ui';

export const metadata: Metadata = { title: 'Funnel · Admin' };

type Row = { source: keyof typeof SOURCE_LABEL; campaign: string; leads: number; qualified: number; matched: number; chose: number;
  trial: number; converted: number; renewed: number; waitlist: number; lost: number };
const COUNT_KEYS = ['leads', 'qualified', 'matched', 'chose', 'trial', 'converted', 'renewed', 'waitlist', 'lost'] as const;

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '—');
const isDate = (s: string | undefined) => (isIsoDate(s) ? s : undefined);

export default async function FunnelPage({ searchParams }: PageProps<'/admin/funnel'>) {
  await requireAdmin();
  const sp = await searchParams;
  const today = istDate();
  const from = isDate(firstParam(sp.from)) ?? addDays(today, -29);
  const to = isDate(firstParam(sp.to)) ?? today;
  const supabase = await createClient();
  const [{ data: funnel, error }, { data: gaps }] = await Promise.all([
    supabase.rpc('lead_funnel', { p_from: from, p_to: to }),
    supabase.rpc('demand_gaps'),
  ]);
  const rows = (funnel ?? []) as Row[];
  const total = COUNT_KEYS.reduce((acc, k) => ({ ...acc, [k]: rows.reduce((s, r) => s + r[k], 0) }), {} as Record<(typeof COUNT_KEYS)[number], number>);
  const input = 'rounded-lg border-0 px-3 py-2 text-sm ring-1 ring-ink-200';
  const th = 'px-3 py-2 text-right';
  const td = 'px-3 py-2 text-right tabular-nums';

  const line = (r: Record<(typeof COUNT_KEYS)[number], number>) => (
    <>
      <td className={td}>{r.leads}</td>
      <td className={td}>{r.qualified} <span className="text-xs text-ink-500">{pct(r.qualified, r.leads)}</span></td>
      <td className={td}>{r.matched}</td>
      <td className={td}>{r.chose}</td>
      <td className={td}>{r.trial} <span className="text-xs text-ink-500">{pct(r.trial, r.qualified)}</span></td>
      <td className={td}>{r.converted} <span className="text-xs text-ink-500">{pct(r.converted, r.trial)}</span></td>
      <td className={td}>{r.renewed} <span className="text-xs text-ink-500">{pct(r.renewed, r.converted)}</span></td>
      <td className={td}>{r.waitlist}</td>
      <td className={td}>{r.lost}</td>
      <td className={`${td} font-medium`}>{pct(r.converted, r.leads)}</td>
    </>
  );

  return (
    <main className="mx-auto max-w-6xl p-4 md:p-8">
      <PageHeader title="Funnel & demand gaps" subtitle="Lead → qualified → trial → plan → month-2 renewal, per source and campaign (by lead creation date, IST)." />
      <form className="mb-4 flex flex-wrap items-end gap-2" action="/admin/funnel">
        <label className="space-y-1 text-sm"><span className="block text-ink-700">From</span><input type="date" name="from" defaultValue={from} className={input} /></label>
        <label className="space-y-1 text-sm"><span className="block text-ink-700">To</span><input type="date" name="to" defaultValue={to} className={input} /></label>
        <button className="rounded-lg bg-white px-4 py-2 text-sm font-medium ring-1 ring-ink-200 hover:bg-ink-50">Show</button>
        <Link href={`/admin/funnel?from=${addDays(today, -6)}&to=${today}`} className="px-2 py-2 text-sm text-brand-700 hover:underline">Last 7 days</Link>
        <Link href={`/admin/funnel?from=${addDays(today, -89)}&to=${today}`} className="px-2 py-2 text-sm text-brand-700 hover:underline">Last 90 days</Link>
      </form>
      {error && <Alert>{error.message}</Alert>}

      <Card className="mb-6 overflow-x-auto p-0">
        <table className="min-w-full text-sm">
          <thead className="border-b border-ink-100 text-xs uppercase text-ink-500">
            <tr>
              <th className="px-3 py-2 text-left">Source / campaign</th>
              <th className={th}>Leads</th>
              <th className={th} title="% of leads">Qualified</th>
              <th className={th}>Matched</th>
              <th className={th}>Picked</th>
              <th className={th} title="% of qualified">Trial</th>
              <th className={th} title="% of trials">Plan</th>
              <th className={th} title="% of plans">Renewed</th>
              <th className={th}>Waitlist</th>
              <th className={th}>Lost</th>
              <th className={th} title="Plans ÷ leads">Lead → plan</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.map((r) => (
              <tr key={`${r.source}-${r.campaign}`}>
                <td className="px-3 py-2">{SOURCE_LABEL[r.source] ?? r.source} <span className="text-ink-500">· {r.campaign}</span></td>
                {line(r)}
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={11} className="px-3 py-6 text-center text-ink-500">No leads in this period.</td></tr>}
          </tbody>
          {rows.length > 0 && (
            <tfoot className="border-t-2 border-ink-200 bg-ink-50 font-semibold">
              <tr><td className="px-3 py-2">Total</td>{line(total)}</tr>
            </tfoot>
          )}
        </table>
        <p className="px-3 py-2 text-xs text-ink-500">Percentages are stage-to-stage: qualified of leads, trial of qualified, plan of trials, renewed of plans.</p>
      </Card>

      <Card title="Demand gaps: where people wait for a kitchen">
        <p className="-mt-2 mb-3 text-sm text-ink-500">Waitlisted leads by area, with the nearest listed kitchen. Recruit kitchens here.</p>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="border-b border-ink-100 text-xs uppercase text-ink-500">
              <tr>
                <th className="px-3 py-2 text-left">Area</th>
                <th className={th}>Waiting</th>
                <th className={th}>Lunch</th>
                <th className={th}>Dinner</th>
                <th className="px-3 py-2 text-left">Nearest kitchen</th>
                <th className={th}>Open applications</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {(gaps ?? []).map((g) => (
                <tr key={g.area}>
                  <td className="px-3 py-2 font-medium">{g.area}</td>
                  <td className={td}>{g.waiting}</td>
                  <td className={td}>{g.lunch}</td>
                  <td className={td}>{g.dinner}</td>
                  <td className="px-3 py-2">{g.nearest_kitchen ? `${g.nearest_kitchen} · ${g.nearest_km} km` : '—'}</td>
                  <td className={td}>{g.open_applications}</td>
                  <td className="px-3 py-2 text-right">
                    {g.open_applications > 0
                      ? <Link href="/admin/vendors" className="text-brand-700 hover:underline">See applications</Link>
                      : <span className="text-amber-700">Recruit kitchens here</span>}
                  </td>
                </tr>
              ))}
              {!gaps?.length && <tr><td colSpan={7} className="px-3 py-6 text-center text-ink-500">Nobody is waiting. Every lead found a kitchen.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </main>
  );
}
