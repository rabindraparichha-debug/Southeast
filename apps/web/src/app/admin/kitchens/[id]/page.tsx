import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { AdminKitchenDetail } from '@tiffin/db';
import { requireAdmin } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { istDateTime } from '@/lib/public';
import { Alert, Badge, Card, PageHeader, ROLE_LABEL } from '@/components/ui';
import { ChangePhoneForm, RevealMemberPhone, SignOutEverywhere, TransferOwnershipForm } from '../../support-tools';
import { ActionList } from '../../action-list';

export const metadata: Metadata = { title: 'Kitchen · Admin' };

const STATUS = { active: 'Listed', draft: 'Private', suspended: 'Suspended' } as const;

// One kitchen for a support call: who owns it, the team, waiting invites, how far setup got,
// and every action the platform team took on it.
export default async function AdminKitchenPage({ params }: PageProps<'/admin/kitchens/[id]'>) {
  await requireAdmin();
  const { id } = await params;
  const supabase = await createClient();
  const [{ data, error }, { data: closeRequests }] = await Promise.all([
    supabase.rpc('admin_kitchen_detail', { p_kitchen: id }),
    supabase.from('kitchen_close_requests').select('id, status, reason, created_at, resolution_note').eq('kitchen_id', id)
      .order('created_at', { ascending: false }).limit(5),
  ]);
  if (error?.message === 'not_found') notFound();
  if (error || !data) return <main className="mx-auto max-w-5xl p-4 md:p-8"><Alert>{error?.message ?? 'Could not load the kitchen.'}</Alert></main>;
  const k = data as unknown as AdminKitchenDetail;
  const s = k.signals;
  const others = k.members.filter((m) => m.role !== 'owner').map((m) => ({ member_id: m.member_id, name: `${m.name ?? 'No name'} (${ROLE_LABEL[m.role] ?? m.role})` }));

  return (
    <main className="mx-auto max-w-5xl space-y-4 p-4 md:p-8">
      <PageHeader
        title={k.kitchen.name}
        subtitle={<>{k.kitchen.area ?? 'No area'} · {STATUS[k.kitchen.status]} · joined {istDateTime(k.kitchen.created_at)} · <Link href="/admin/kitchens" className="text-brand-700 hover:underline">all kitchens</Link></>}
      />
      {(closeRequests ?? []).filter((r) => r.status === 'open').map((r) => (
        <Alert key={r.id} tone="amber">The owner asked to close this kitchen on {istDateTime(r.created_at)}{r.reason ? `: “${r.reason}”` : ''}. Handle it under <Link href="/admin/access" className="underline">Access</Link>.</Alert>
      ))}

      <Card title="Owner">
        {k.owner ? (
          <div className="space-y-1 text-sm">
            <div className="font-medium">{k.owner.name ?? 'No name'}</div>
            <RevealMemberPhone userId={k.owner.user_id} kitchenId={k.kitchen.id} masked={k.owner.phone} />
            <div className="text-xs text-ink-500">Last login {k.owner.last_sign_in_at ? istDateTime(k.owner.last_sign_in_at) : 'never'}</div>
            <div className="flex flex-wrap gap-3">
              <ChangePhoneForm userId={k.owner.user_id} name={k.owner.name ?? 'the owner'} />
              <SignOutEverywhere userId={k.owner.user_id} name={k.owner.name ?? 'the owner'} />
            </div>
          </div>
        ) : <p className="text-sm text-ink-500">No owner found.</p>}
      </Card>

      <Card title={`Team (${k.members.length})`}>
        <ul className="divide-y divide-ink-100 text-sm">
          {k.members.map((m) => (
            <li key={m.member_id} className="py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{m.name ?? 'No name'}</span>
                <Badge tone={m.role === 'owner' ? 'green' : 'gray'}>{ROLE_LABEL[m.role] ?? m.role}</Badge>
                <RevealMemberPhone userId={m.user_id} kitchenId={k.kitchen.id} masked={m.phone} />
                <span className="text-xs text-ink-500">joined {istDateTime(m.joined_at)} · last login {m.last_sign_in_at ? istDateTime(m.last_sign_in_at) : 'never'}</span>
              </div>
              {m.role !== 'owner' && (
                <div className="flex flex-wrap gap-3">
                  <ChangePhoneForm userId={m.user_id} name={m.name ?? 'this member'} />
                  <SignOutEverywhere userId={m.user_id} name={m.name ?? 'this member'} />
                </div>
              )}
            </li>
          ))}
        </ul>
        {k.invites.length > 0 && (
          <div className="mt-3 border-t border-ink-100 pt-3 text-sm">
            <div className="mb-1 text-xs font-medium text-ink-600">Waiting invites (claimed at their first login)</div>
            <ul className="space-y-1">
              {k.invites.map((i) => (
                <li key={i.id}>{i.name ?? 'No name'} · {ROLE_LABEL[i.role] ?? i.role} · <span className="font-mono">{i.phone}</span> · sent {istDateTime(i.created_at)}</li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <Card title="Setup and use">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
          <Fact label="Active plans" value={s.plans} warn={!s.plans} />
          <Fact label="Customers" value={s.customers} warn={!s.customers} />
          <Fact label="Live subscriptions" value={s.live_subscriptions} />
          <Fact label="Meals, last 7 days" value={s.meals_7d} />
          <Fact label="Routes" value={`${s.routes}${s.routes_without_rider ? ` (${s.routes_without_rider} without rider)` : ''}`} warn={s.routes_without_rider > 0} />
          <Fact label="Staff / riders" value={`${s.staff} / ${s.riders}`} />
          <Fact label="Credit limit / grace" value={`${s.credit_limit_meals ?? 0} meals / ${s.grace_days ?? 0} days`} />
          <Fact label="Last count lock" value={s.last_lock ? istDateTime(s.last_lock) : 'Never'} />
          <Fact label="Last activity" value={s.last_activity ? istDateTime(s.last_activity) : 'Never'} />
          <Fact label="Open complaints" value={s.open_complaints} warn={s.open_complaints > 0} />
          <Fact label="Engine errors" value={s.open_engine_errors} warn={s.open_engine_errors > 0} />
          <Fact label="Application" value={k.application ? `${k.application.status}${k.application.approved_at ? ', approved' : ''}` : 'None'} />
        </dl>
      </Card>

      <Card title="Transfer ownership">
        <TransferOwnershipForm kitchenId={k.kitchen.id} members={others} />
      </Card>

      <Card title="Platform team actions">
        <ActionList actions={k.actions} />
      </Card>
    </main>
  );
}

function Fact({ label, value, warn }: { label: string; value: string | number; warn?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-ink-500">{label}</dt>
      <dd className={`font-medium ${warn ? 'text-amber-700' : ''}`}>{value}</dd>
    </div>
  );
}
