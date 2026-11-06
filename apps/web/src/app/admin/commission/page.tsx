import type { Metadata } from 'next';
import { formatPaise, istDate, isIsoDate } from '@tiffin/core';
import { requireAdmin } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { bpsLabel } from '@/lib/p5';
import { Alert, Card, PageHeader, Stat } from '@/components/ui';
import { CommissionForm } from './commission-form';

export const metadata: Metadata = { title: 'Commission · Admin' };

type Transfer = {
  payment_id: string; kitchen_name: string; transfer_paise: number; paid_at: string; transfer_status: string;
  transfer_error: string | null; expected_account: string | null; transfer_account: string | null; reason: 'failed' | 'reversed' | 'overdue' | 'account_mismatch';
};
const REASON: Record<Transfer['reason'], string> = {
  failed: 'Failed', reversed: 'Reversed', overdue: 'No confirmation after 24 h', account_mismatch: 'Paid to another account',
};

type Report = {
  total_commission_paise: number;
  kitchens: { kitchen_id: string; kitchen_name: string; commission_bps: number; payments: number; gross_paise: number; commission_paise: number; transferred_paise: number }[];
};

// Platform commission (P6): a rate per kitchen, applied only to online payments of customers the
// platform brought. Default 0 = nothing changes. The rest of each payment goes to the kitchen.
export default async function AdminCommissionPage({ searchParams }: PageProps<'/admin/commission'>) {
  await requireAdmin();
  const sp = await searchParams;
  const today = istDate();
  const from = isIsoDate(sp.from) ? sp.from : `${today.slice(0, 8)}01`;
  const to = isIsoDate(sp.to) ? sp.to : today;
  const supabase = await createClient();
  const [{ data: kitchens }, { data: accounts }, { data: reportRaw, error }, { data: transfersRaw }] = await Promise.all([
    supabase.from('kitchens').select('id, name').order('name'),
    supabase.from('kitchen_payout_accounts').select('kitchen_id, commission_bps, kyc_status'),
    supabase.rpc('admin_commission_report', { p_from: from, p_to: to }),
    // Route transfers that need a look (D-146): failed, reversed, unconfirmed after a day, wrong account.
    supabase.rpc('admin_route_transfers', {}),
  ]);
  const transfers = (transfersRaw ?? []) as unknown as Transfer[];
  const report = reportRaw as unknown as Report | null;
  const account = new Map((accounts ?? []).map((a) => [a.kitchen_id, a]));

  return (
    <main className="mx-auto max-w-6xl p-4 md:p-8">
      <PageHeader title="Admin · Commission" subtitle="Only online payments from platform-sourced customers carry a commission. Kitchens see what was kept on their Insights page." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Rate per kitchen">
          <ul className="divide-y divide-ink-100 text-sm" data-testid="commission-rates">
            {(kitchens ?? []).map((k) => {
              const a = account.get(k.id);
              return (
                <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <div className="min-w-0">
                    <div className="font-medium">{k.name}</div>
                    <div className="text-xs text-ink-500">{a ? `Now ${bpsLabel(a.commission_bps)} · KYC ${a.kyc_status.replace('_', ' ')}` : 'No payout account yet'}</div>
                  </div>
                  {a && <CommissionForm kitchenId={k.id} bps={a.commission_bps} />}
                </li>
              );
            })}
          </ul>
        </Card>

        <Card title="Report" actions={
          <form className="flex flex-wrap items-center gap-2">
            <input type="date" name="from" defaultValue={from} aria-label="From" className="rounded-lg px-2 py-1.5 text-sm ring-1 ring-ink-200" />
            <input type="date" name="to" defaultValue={to} aria-label="To" className="rounded-lg px-2 py-1.5 text-sm ring-1 ring-ink-200" />
            <button className="rounded-lg bg-white px-3 py-1.5 text-sm ring-1 ring-ink-200">Show</button>
          </form>
        }>
          {error && <Alert>{error.message}</Alert>}
          {report && (
            <>
              <Stat label="Commission kept" value={formatPaise(report.total_commission_paise)} />
              <div className="mt-4 overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="border-b border-ink-100 text-left text-xs uppercase text-ink-500">
                    <tr><th className="py-2 pr-3">Kitchen</th><th className="py-2 pr-3 text-right">Rate</th><th className="py-2 pr-3 text-right">Payments</th><th className="py-2 pr-3 text-right">Gross</th><th className="py-2 text-right">Kept</th></tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {report.kitchens.map((r) => (
                      <tr key={r.kitchen_id}>
                        <td className="py-2 pr-3">{r.kitchen_name}</td>
                        <td className="py-2 pr-3 text-right">{bpsLabel(r.commission_bps)}</td>
                        <td className="py-2 pr-3 text-right">{r.payments}</td>
                        <td className="py-2 pr-3 text-right">{formatPaise(r.gross_paise)}</td>
                        <td className="py-2 text-right">{formatPaise(r.commission_paise)}</td>
                      </tr>
                    ))}
                    {!report.kitchens.length && <tr><td colSpan={5} className="py-4 text-center text-ink-500">No kitchen has a commission set.</td></tr>}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
      </div>
      <Card title={`Route transfers needing attention (${transfers.length})`} className="mt-6">
        <p className="mb-2 text-sm text-ink-500">
          Razorpay confirms each kitchen&apos;s share with transfer webhooks. A failed or missing transfer means the kitchen was not paid: check it in the Razorpay dashboard.
        </p>
        <ul className="divide-y divide-ink-100 text-sm" data-testid="route-transfers">
          {transfers.map((t) => (
            <li key={t.payment_id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="min-w-0">
                <span className="font-medium">{t.kitchen_name}</span> · {formatPaise(t.transfer_paise)} · paid {new Date(t.paid_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' })}
                {t.transfer_error && <span className="block text-xs text-red-700">{t.transfer_error}</span>}
                {t.reason === 'account_mismatch' && <span className="block text-xs text-ink-500">Expected {t.expected_account}, went to {t.transfer_account}</span>}
              </span>
              <span className="text-xs font-medium text-red-700">{REASON[t.reason]}</span>
            </li>
          ))}
          {!transfers.length && <li className="py-3 text-ink-500">Nothing to check.</li>}
        </ul>
      </Card>
    </main>
  );
}
