import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { formatPaise } from '@tiffin/core';
import { requireAdmin } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { istDateTime } from '@/lib/public';
import { Alert, Badge, Card, PageHeader } from '@/components/ui';
import { GoalBar } from './goal-bar';
import { share, type PlatformMetrics } from './types';

export const metadata: Metadata = { title: 'Dashboard · Admin' };

// Platform dashboard (M8): the phase goals and what needs attention today.
export default async function AdminDashboard() {
  const session = await requireAdmin();
  const supabase = await createClient();
  const [{ data, error }, { data: escalated }, { data: kitchens }] = await Promise.all([
    supabase.rpc('platform_metrics'),
    supabase.from('complaints').select('id, category, description, created_at, escalated_at, kitchen_id')
      .eq('status', 'escalated').order('escalated_at'),
    supabase.from('kitchens').select('id, name'),
  ]);
  const m = data as unknown as PlatformMetrics | null;
  const kitchenName = new Map((kitchens ?? []).map((k) => [k.id, k.name]));

  return (
    <main className="mx-auto max-w-6xl p-4 md:p-8">
      <PageHeader
        title="Admin · Dashboard"
        subtitle="Platform health and phase goals. Every admin action is written to the audit log."
        actions={session.kitchen && <Link href="/" className="text-sm text-brand-700 hover:underline">Back to my kitchen</Link>}
      />
      {error && <Alert>{error.message}</Alert>}
      {m && <Metrics m={m} />}

      <div id="escalated" className="scroll-mt-20" />
      <Card title={`Escalated complaints (${escalated?.length ?? 0})`} className="mt-6">
        {escalated?.length ? (
          <ul className="divide-y divide-ink-100 text-sm">
            {escalated.map((c) => (
              <li key={c.id} className="py-2">
                <strong>{kitchenName.get(c.kitchen_id) ?? 'Kitchen'}</strong> · {c.category}
                {c.description ? ` · ${c.description}` : ''}
                <span className="text-ink-500"> · no kitchen reply within 2 hours{c.escalated_at ? ` (escalated ${istDateTime(c.escalated_at)})` : ''}</span>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-ink-500">None. Kitchens are replying within 2 hours.</p>}
      </Card>
    </main>
  );
}

function Metrics({ m }: { m: PlatformMetrics }) {
  const d = m.last_7_days;
  const waShare = share(d.whatsapp_changes, d.all_changes);
  const proved = share(d.stops_proved, d.stops);
  const goal = m.kitchens.goal_live || 30;
  const p4Met = m.kitchens.active >= goal && m.customers.platform_paid > 0;

  return (
    <div className="space-y-6">
      <Card
        title={<>P4 goal: {goal} vendors live and first platform-sourced customers paid</>}
        actions={<Badge tone={p4Met ? 'green' : 'amber'}>{p4Met ? 'Met' : 'In progress'}</Badge>}
      >
        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <div className="mb-2 text-sm text-ink-700"><strong className="text-2xl text-ink-900">{m.kitchens.active}</strong> / {goal} kitchens live</div>
            <GoalBar value={m.kitchens.active} goal={goal} label="Kitchens live" />
            <p className="mt-2 text-xs text-ink-500">
              {m.kitchens.total} kitchens in all · {m.kitchens.draft} private · {m.kitchens.suspended} suspended ·{' '}
              <Link href="/admin/kitchens" className="text-brand-700 hover:underline">Manage kitchens</Link>
            </p>
          </div>
          <div>
            <div className="mb-2 text-sm text-ink-700">
              <strong className="text-2xl text-ink-900">{m.customers.platform_paid}</strong> platform-sourced customers paid
            </div>
            <p className="text-sm text-ink-600">
              {m.customers.platform_paid > 0 ? '✓ First paying platform customers.' : 'None yet.'}{' '}
              {m.customers.platform_sourced} customer{m.customers.platform_sourced === 1 ? '' : 's'} came through the platform in all.
            </p>
            <p className="mt-2 text-xs text-ink-500"><Link href="/admin/funnel" className="text-brand-700 hover:underline">Open the lead funnel</Link></p>
          </div>
        </div>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <MetricCard title="P2 goal: half of changes via WhatsApp" hint="Pauses, skips and payments requested by customers on WhatsApp or their page, last 7 days.">
          <div className="mb-2 text-2xl font-semibold text-ink-900">{waShare == null ? '—' : `${waShare}%`}</div>
          <GoalBar value={waShare} goal={50} max={100} unit="%" label="WhatsApp share of changes" />
          <p className="mt-2 text-xs text-ink-500">
            {d.whatsapp_changes} of {d.all_changes} changes · {m.customers.whatsapp_pct ?? 0}% of customers opted in ({m.customers.on_whatsapp} of {m.customers.total})
          </p>
        </MetricCard>
        <MetricCard title="Deliveries with proof" hint="Delivered with the customer’s code or a photo, last 7 days.">
          <div className="mb-2 text-2xl font-semibold text-ink-900">{proved == null ? '—' : `${proved}%`}</div>
          <GoalBar value={proved} goal={90} max={100} unit="%" label="Stops proved" />
          <p className="mt-2 text-xs text-ink-500">{d.stops_proved} of {d.stops} finished stops</p>
        </MetricCard>
        <MetricCard title="Collections, last 7 days" hint="Paid payments across all kitchens (settled to the kitchens, not to us).">
          <div className="text-2xl font-semibold text-ink-900">{formatPaise(d.collections_paise)}</div>
          <p className="mt-2 text-xs text-ink-500">{d.meals.toLocaleString('en-IN')} meals counted in the last 7 days</p>
        </MetricCard>
        <MetricCard title="Customers">
          <div className="text-2xl font-semibold text-ink-900">{m.customers.total.toLocaleString('en-IN')}</div>
          <p className="mt-2 text-xs text-ink-500">{m.customers.on_whatsapp} on WhatsApp · {m.customers.platform_sourced} from the platform</p>
        </MetricCard>
        <MetricCard title="Subscriptions">
          <div className="text-2xl font-semibold text-ink-900">{m.subscriptions.live.toLocaleString('en-IN')} <span className="text-sm font-normal text-ink-500">live</span></div>
          <p className="mt-2 text-xs text-ink-500">{m.subscriptions.trial} on trial · {m.subscriptions.autopay} on autopay</p>
        </MetricCard>
        <MetricCard title="Growth, last 7 days">
          <div className="text-2xl font-semibold text-ink-900">{d.leads} <span className="text-sm font-normal text-ink-500">customer leads</span></div>
          <p className="mt-2 text-xs text-ink-500">{d.vendor_applications} kitchen applications</p>
        </MetricCard>
      </div>

      <Card title="Needs attention">
        <ul className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <OpenItem n={m.open.escalated_complaints} label="Escalated complaints" href="#escalated" tone="red" />
          <OpenItem n={m.open.vendor_applications} label="Open vendor applications" href="/admin/vendors" tone="amber" />
          <OpenItem n={m.open.waitlisted_leads} label="Waitlisted leads (no kitchen yet)" href="/admin/funnel" tone="amber" />
          <OpenItem n={m.open.outbox_failed} label="Failed WhatsApp messages (7 days)" tone="red"
            hint="See notifications_outbox (status failed) in Supabase Studio." />
        </ul>
      </Card>
    </div>
  );
}

function MetricCard({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-ink-100">
      <h2 className="mb-2 text-sm font-medium text-ink-600" title={hint}>{title}</h2>
      {children}
    </section>
  );
}

function OpenItem({ n, label, href, hint, tone }: { n: number; label: string; href?: string; hint?: string; tone: 'red' | 'amber' }) {
  const body = (
    <>
      <span className={`text-2xl font-semibold ${n > 0 ? (tone === 'red' ? 'text-red-700' : 'text-amber-700') : 'text-ink-400'}`}>{n}</span>
      <span className="block text-ink-700">{label}</span>
      {hint && <span className="block text-xs text-ink-500">{hint}</span>}
    </>
  );
  return (
    <li className="rounded-lg p-3 ring-1 ring-ink-100">
      {href ? <Link href={href} className="block hover:underline">{body}</Link> : body}
    </li>
  );
}
