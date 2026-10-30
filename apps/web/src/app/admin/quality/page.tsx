import type { Metadata } from 'next';
import { requireAdmin } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import type { VendorScore } from '@/lib/p5';
import { Alert, Badge, Card, PageHeader } from '@/components/ui';

export const metadata: Metadata = { title: 'Complaint scores · Admin' };

const DAYS = [7, 30, 90] as const;

// Complaint score per kitchen (P5): complaints per 100 delivered meals, reply speed, escalations.
export default async function AdminQualityPage({ searchParams }: PageProps<'/admin/quality'>) {
  await requireAdmin();
  const sp = await searchParams;
  const days = DAYS.find((d) => String(d) === sp.days) ?? 30;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('admin_complaint_scores', { p_days: days });
  const rows = ((data ?? []) as unknown as VendorScore[]).slice().sort((a, b) => (b.complaints_per_100_meals ?? -1) - (a.complaints_per_100_meals ?? -1));

  return (
    <main className="mx-auto max-w-6xl p-4 md:p-8">
      <PageHeader title="Admin · Complaint scores" subtitle="Worst first. Under 1 complaint per 100 meals is good; over 3 needs a call."
        actions={
          <div className="flex gap-1">
            {DAYS.map((d) => (
              <a key={d} href={`/admin/quality?days=${d}`} className={`rounded-lg px-3 py-1.5 text-sm ring-1 ${d === days ? 'bg-ink-800 text-white ring-ink-800' : 'ring-ink-200'}`}>{d} days</a>
            ))}
          </div>
        } />
      {error && <Alert>{error.message}</Alert>}
      <Card className="overflow-x-auto p-0">
        <table className="min-w-full text-sm" data-testid="scores">
          <thead className="border-b border-ink-100 text-left text-xs uppercase text-ink-500">
            <tr>
              <th className="px-4 py-3">Kitchen</th>
              <th className="px-4 py-3 text-right">Complaints</th>
              <th className="px-4 py-3 text-right">Meals</th>
              <th className="px-4 py-3 text-right">Per 100</th>
              <th className="px-4 py-3 text-right">First reply</th>
              <th className="px-4 py-3 text-right">Unanswered</th>
              <th className="px-4 py-3 text-right">Escalated</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.map((r) => {
              const per = r.complaints_per_100_meals;
              return (
                <tr key={r.kitchen_id}>
                  <td className="px-4 py-2.5">
                    <div className="font-medium">{r.kitchen_name}</div>
                    <div className="text-xs text-ink-500">{Object.entries(r.by_category).map(([c, n]) => `${c} ${n}`).join(' · ')}</div>
                  </td>
                  <td className="px-4 py-2.5 text-right">{r.complaints}</td>
                  <td className="px-4 py-2.5 text-right">{r.delivered_meals}</td>
                  <td className="px-4 py-2.5 text-right">
                    {per == null ? '—' : <Badge tone={per > 3 ? 'red' : per > 1 ? 'amber' : 'green'}>{per}</Badge>}
                  </td>
                  <td className="px-4 py-2.5 text-right">{r.median_first_response_minutes != null ? `${r.median_first_response_minutes} min` : '—'}</td>
                  <td className="px-4 py-2.5 text-right">{r.unanswered || ''}</td>
                  <td className="px-4 py-2.5 text-right">{r.escalated || ''}</td>
                </tr>
              );
            })}
            {!rows.length && <tr><td colSpan={7} className="px-4 py-6 text-center text-ink-500">No kitchens.</td></tr>}
          </tbody>
        </table>
      </Card>
    </main>
  );
}
