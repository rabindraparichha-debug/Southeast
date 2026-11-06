import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { formatPaise, formatServiceDate } from '@tiffin/core';
import { requireAdmin } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { istDateTime } from '@/lib/public';
import { Badge, Card, PageHeader } from '@/components/ui';
import { CATEGORY_LABEL, type ComplaintDetail, type EscalationQueue } from '../types';
import { ComplaintActions, RevealComplaintPhone } from './complaint-actions';

export const metadata: Metadata = { title: 'Complaint · Admin' };

const EVENT_LABEL: Record<string, string> = {
  assign: 'Assigned', note: 'Note', reveal_customer_phone: 'Customer’s number revealed', reveal_owner_phone: 'Owner’s number revealed',
  resolve: 'Resolved by the team',
};

export default async function ComplaintPage({ params }: PageProps<'/admin/complaints/[id]'>) {
  await requireAdmin();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  const [{ data }, { data: queue }] = await Promise.all([
    supabase.rpc('admin_complaint_detail', { p_complaint: id }),
    supabase.rpc('admin_escalations', { p_status: 'open', p_limit: 1 }),
  ]);
  const d = data as unknown as ComplaintDetail | null;
  if (!d) notFound();
  const team = (queue as unknown as EscalationQueue | null)?.team ?? [];
  const c = d.complaint;

  const facts: [string, ReactNode][] = [
    ['Kitchen', `${d.kitchen.name}${d.kitchen.area ? `, ${d.kitchen.area}` : ''}`],
    ['Owner', <span key="o">{d.kitchen.owner_name ?? '—'} · <RevealComplaintPhone complaintId={c.id} who="owner" masked={d.kitchen.owner_phone_masked ?? '—'} /></span>],
    ['Customer', <span key="c">{d.customer.name}{d.customer.platform_sourced ? ' (via Tiffin)' : ''} · <RevealComplaintPhone complaintId={c.id} who="customer" masked={d.customer.phone_masked} /></span>],
    ['Customer since', istDateTime(d.customer.since)],
    ['Plans', d.customer.subscriptions.length
      ? d.customer.subscriptions.map((s) => `${s.plan} (${s.status}, ${formatPaise(s.price_per_meal_paise)}/meal)`).join('; ') : 'None live'],
    ['Balance', `${d.customer.balance_meals} meals`],
    ['Complaints in 90 days', String(d.customer.complaints_90d)],
    ['Meal', d.meal ? `${formatServiceDate(d.meal.date)} ${d.meal.slot} (${d.meal.status})` : '—'],
    ['Opened', `${istDateTime(c.created_at)} via ${c.channel}`],
    ['Escalated', c.escalated_at ? istDateTime(c.escalated_at) : '—'],
  ];

  return (
    <main className="mx-auto max-w-4xl p-4 md:p-8">
      <Link href="/admin/complaints" className="text-sm text-brand-700 hover:underline">← Complaints</Link>
      <PageHeader title={`${CATEGORY_LABEL[c.category] ?? c.category} complaint`}
        actions={<Badge tone={c.status === 'resolved' ? 'green' : c.status === 'escalated' ? 'red' : 'gray'}>{c.status}</Badge>} />
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="What happened">
          <p className="whitespace-pre-line text-sm text-ink-800">{c.description || 'No details given.'}</p>
          {c.photo_url && <a href={c.photo_url} target="_blank" rel="noreferrer" className="mt-2 inline-block text-sm text-brand-700 underline">Photo</a>}
          {c.resolution_note && <p className="mt-3 rounded-lg bg-green-50 p-2 text-sm text-green-900">Resolution: {c.resolution_note}</p>}
          <dl className="mt-4 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-sm">
            {facts.map(([k, v]) => (
              <div key={k} className="contents"><dt className="text-ink-500">{k}</dt><dd className="text-ink-800">{v}</dd></div>
            ))}
          </dl>
        </Card>
        <Card title="Team">
          <ComplaintActions complaintId={c.id} resolved={c.status === 'resolved'} assignedTo={c.assigned_admin_id} team={team} />
          <ul className="mt-4 space-y-1 border-t border-ink-100 pt-3 text-xs text-ink-600">
            {d.events.map((e, i) => (
              <li key={i}>{istDateTime(e.at)} · {e.admin ?? 'Team'} · {EVENT_LABEL[e.action] ?? e.action}{e.note ? `: ${e.note}` : ''}</li>
            ))}
            {!d.events.length && <li>No team activity yet.</li>}
          </ul>
        </Card>
      </div>
      <Card title="Conversation (last 20 messages)" className="mt-4">
        {d.messages.length ? (
          <ul className="space-y-2 text-sm">
            {d.messages.map((m, i) => (
              <li key={i} className={m.direction === 'in' ? 'mr-12 rounded-lg bg-ink-50 p-2' : 'ml-12 rounded-lg bg-brand-50 p-2'}>
                <div className="whitespace-pre-line">{m.body ?? '(attachment)'}</div>
                <div className="mt-0.5 text-xs text-ink-500">{istDateTime(m.at)} · {m.direction === 'in' ? 'customer' : m.handled_by}</div>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-ink-500">No WhatsApp conversation for this customer.</p>}
      </Card>
    </main>
  );
}
