import Link from 'next/link';
import { SLOT_LABEL, formatPaise, istDate } from '@tiffin/core';
import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { friendlyError } from '@/lib/errors';
import { formatIstDateTime } from '@/lib/delivery';
import {
  REFERRAL_STATUS, RISK_LABEL, WEATHER_LABEL, bpsLabel, shortDate,
  type CommissionStatement, type Referral, type VendorScore, type WeatherAlert,
} from '@/lib/p5';
import { Alert, Badge, Card, PageHeader, Stat } from '@/components/ui';
import { RefreshRisks } from './refresh-risks';

const CATEGORY_LABEL: Record<string, string> = {
  late: 'Late', quality: 'Quality', quantity: 'Quantity', missing: 'Missing item', hygiene: 'Hygiene', delivery: 'Delivery',
  billing: 'Billing', privacy: 'Privacy', other: 'Other',
};

// Owner insights (P5/P6): customers who may leave, complaint score, referrals, weather alerts and,
// only when the platform takes a commission, what it kept.
export default async function InsightsPage() {
  const { kitchen } = await requireKitchen(['owner']);
  const supabase = await createClient();
  const today = istDate();
  const monthStart = `${today.slice(0, 8)}01`;
  const [risks, score, referrals, weather, commission] = await Promise.all([
    supabase.rpc('at_risk_customers', { p_kitchen: kitchen.kitchenId }),
    supabase.rpc('vendor_complaint_score', { p_kitchen: kitchen.kitchenId, p_days: 30 }),
    supabase.rpc('referrals_list', { p_kitchen: kitchen.kitchenId }),
    supabase.rpc('weather_alerts_list', { p_kitchen: kitchen.kitchenId, p_days: 14 }),
    supabase.rpc('commission_statement', { p_kitchen: kitchen.kitchenId, p_from: monthStart, p_to: today }),
  ]);
  const atRisk = risks.data ?? [];
  const s = score.data as unknown as VendorScore | null;
  const refs = (referrals.data ?? []) as unknown as Referral[];
  const alerts = (weather.data ?? []) as unknown as WeatherAlert[];
  const comm = commission.data as unknown as CommissionStatement | null;
  const showCommission = comm && ((comm.commission_bps ?? 0) > 0 || comm.rows.length > 0);
  const computedOn = atRisk[0]?.computed_on;

  return (
    <>
      <PageHeader title="Insights" subtitle="Who may leave, how complaints are going, referrals and alerts." />

      {s && (
        <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="complaint-score">
          <Stat label="Complaints, 30 days" value={s.complaints} hint={`${s.delivered_meals} meals delivered`} />
          <Stat label="Per 100 meals" value={s.complaints_per_100_meals ?? '—'} hint="Lower is better. Under 1 is good." />
          <Stat label="First reply (median)" value={s.median_first_response_minutes != null ? `${s.median_first_response_minutes} min` : '—'}
            hint={s.unanswered ? `${s.unanswered} not answered yet` : 'All answered'} />
          <Stat label="Escalated to Tiffin" value={s.escalated}
            hint={Object.entries(s.by_category).map(([c, n]) => `${CATEGORY_LABEL[c] ?? c} ${n}`).join(' · ') || 'No complaints'} />
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={`Customers who may leave (${atRisk.length})`} className="lg:col-span-2"
          actions={<RefreshRisks kitchenId={kitchen.kitchenId} />}>
          {risks.error && <Alert>{friendlyError(risks.error)}</Alert>}
          <p className="mb-3 text-xs text-ink-500">
            {computedOn ? `Checked ${shortDate(computedOn)}. ` : ''}Checked every night. A call or a WhatsApp now often keeps them.
          </p>
          <ul className="divide-y divide-ink-100 text-sm" data-testid="at-risk">
            {atRisk.map((r) => {
              const d = (r.detail ?? {}) as Record<string, unknown>;
              return (
                <li key={r.customer_id} className="flex flex-wrap items-start justify-between gap-2 py-2.5">
                  <div className="min-w-0">
                    <Link href={`/customers/${r.customer_id}`} className="font-medium hover:text-brand-700">{r.customer_name}</Link>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {r.reasons.map((x) => <Badge key={x} tone={x === 'open_complaint' || x === 'balance_out' ? 'red' : 'amber'}>{RISK_LABEL[x] ?? x}</Badge>)}
                    </div>
                  </div>
                  <div className="text-right text-xs text-ink-500">
                    {typeof d.balance_meals === 'number' && <div>Balance {d.balance_meals} meals</div>}
                    {typeof d.skips_7d === 'number' && d.skips_7d > 0 && <div>{d.skips_7d} skips this week</div>}
                  </div>
                </li>
              );
            })}
            {!atRisk.length && !risks.error && <li className="py-3 text-ink-500">No one looks at risk. 🎉</li>}
          </ul>
        </Card>

        <Card title={`Referrals (${refs.length})`}>
          {referrals.error && <Alert>{friendlyError(referrals.error)}</Alert>}
          <ul className="divide-y divide-ink-100 text-sm" data-testid="referrals">
            {refs.map((r) => (
              <li key={r.id} className="space-y-0.5 py-2">
                <div>
                  <Link href={`/customers/${r.referrer_customer_id}`} className="font-medium hover:text-brand-700">{r.referrer_name}</Link>
                  {' → '}
                  <Link href={`/customers/${r.referee_customer_id}`} className="font-medium hover:text-brand-700">{r.referee_name}</Link>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-ink-500">
                  <Badge tone={REFERRAL_STATUS[r.status].tone}>{REFERRAL_STATUS[r.status].label}</Badge>
                  {r.status === 'rewarded' && <span>{r.reward_meals} meals each</span>}
                  <span>{formatIstDateTime(r.created_at)}</span>
                </div>
              </li>
            ))}
            {!refs.length && <li className="py-3 text-ink-500">No referrals yet. Each customer has a code on their page to share.</li>}
          </ul>
          <p className="mt-3 text-xs text-ink-500"><Link href="/settings" className="text-brand-700 hover:underline">Referral reward</Link> is set in Kitchen settings (0 = off).</p>
        </Card>

        <Card title="Weather alerts (14 days)">
          {weather.error && <Alert>{friendlyError(weather.error)}</Alert>}
          <ul className="divide-y divide-ink-100 text-sm" data-testid="weather">
            {alerts.map((a, i) => (
              <li key={i} className="flex flex-wrap justify-between gap-2 py-2">
                <span>{shortDate(a.service_date)} · {SLOT_LABEL[a.slot]} · <strong>{WEATHER_LABEL[a.kind] ?? a.kind}</strong></span>
                <span className="text-xs text-ink-500">{a.customers_notified ? `${a.customers_notified} customers told` : 'Only you were told'}</span>
              </li>
            ))}
            {!alerts.length && <li className="py-3 text-ink-500">No rain or heat alerts.</li>}
          </ul>
          <p className="mt-3 text-xs text-ink-500">Turn alerts on or off in <Link href="/settings" className="text-brand-700 hover:underline">Kitchen settings</Link>.</p>
        </Card>

        {showCommission && (
          <Card title="Tiffin platform commission (this month)" className="lg:col-span-2">
            <p className="text-sm text-ink-600">
              For customers who found you through Tiffin, the platform keeps <strong>{bpsLabel(comm.commission_bps)}</strong> of each online payment;
              the rest goes straight to your bank. Your own customers are never charged.
            </p>
            <p className="mt-2 text-sm">Kept this month: <strong>{formatPaise(comm.commission_paise)}</strong></p>
            {comm.rows.length > 0 && (
              <div className="mt-3 overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="border-b border-ink-100 text-left text-xs uppercase text-ink-500">
                    <tr><th className="py-2 pr-3">Date</th><th className="py-2 pr-3">Customer</th><th className="py-2 pr-3 text-right">Paid</th><th className="py-2 pr-3 text-right">Commission</th><th className="py-2 text-right">To you</th></tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {comm.rows.map((r) => (
                      <tr key={r.payment_id}>
                        <td className="py-2 pr-3">{formatIstDateTime(r.created_at)}</td>
                        <td className="py-2 pr-3">{r.customer_name}</td>
                        <td className="py-2 pr-3 text-right">{formatPaise(r.amount_paise)}</td>
                        <td className="py-2 pr-3 text-right">{formatPaise(r.commission_paise)}</td>
                        <td className="py-2 text-right">{formatPaise(r.transfer_paise)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
