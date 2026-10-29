import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { formatPaise } from '@tiffin/core';
import { requireAdmin } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { istDateTime, LEAD_STATUS_LABEL, LEAD_STATUS_TONE, ratingLabel, SOURCE_LABEL } from '@/lib/public';
import { Badge, Card, DIET_LABEL, LANGUAGE_LABEL, PageHeader } from '@/components/ui';
import { RevealPhone } from '../../reveal-phone';
import { LeadActions } from './lead-actions';
import type { AdminLeadDetail } from '../types';

export const metadata: Metadata = { title: 'Lead · Admin' };

const SLOT = { lunch: 'Lunch', dinner: 'Dinner' } as const;
const EVENT_LABEL: Record<string, string> = {
  created: 'Lead created', updated: 'Details updated', matched: 'Matched with kitchens', waitlist: 'No kitchen with space: waitlist',
  chose_kitchen: 'Picked a kitchen', trial_paid: 'Trial paid', converted: 'Bought a plan', renewed: 'Renewed (month 2)',
  reminded: 'Reminder sent', trial_followup: 'Trial follow-up sent', phone_revealed: 'Phone number revealed by the team',
};

function eventText(e: { event: string; detail: Record<string, unknown> }) {
  const base = EVENT_LABEL[e.event] ?? (e.event.startsWith('status_') ? `Status set to ${e.event.slice(7)}` : e.event);
  const d = e.detail ?? {};
  const extra = [
    d.kitchens != null && e.event === 'matched' ? `${d.kitchens} kitchens` : null,
    typeof d.meals === 'number' ? `${d.meals} meals` : null,
    typeof d.reason === 'string' && d.reason ? `“${d.reason}”` : null,
    typeof d.channel === 'string' ? `via ${d.channel}` : null,
    typeof d.source === 'string' && e.event === 'created' ? `${d.source}${d.campaign ? ` / ${d.campaign}` : ''}` : null,
  ].filter(Boolean);
  return extra.length ? `${base} · ${extra.join(' · ')}` : base;
}

export default async function LeadDetailPage({ params }: PageProps<'/admin/leads/[id]'>) {
  await requireAdmin();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  const { data } = await supabase.rpc('admin_lead_detail', { p_lead: id });
  const l = data as unknown as AdminLeadDetail | null;
  if (!l) notFound();

  const facts: [string, ReactNode][] = [
    ['Phone', <RevealPhone key="p" kind="lead" id={l.id} masked={l.phone} />],
    ['Source', `${SOURCE_LABEL[l.source]}${l.campaign ? ` · ${l.campaign}` : ''}`],
    ['Area', l.area ?? '—'],
    ['Location', l.lat != null && l.lng != null ? `${l.lat.toFixed(4)}, ${l.lng.toFixed(4)}` : 'Not shared'],
    ['Address', l.address_text ?? '—'],
    ['Meals', l.slots?.map((s) => SLOT[s]).join(' + ') ?? '—'],
    ['Food', l.diet ? DIET_LABEL[l.diet] : '—'],
    ['Budget per meal', l.budget_per_meal_paise ? formatPaise(l.budget_per_meal_paise) : 'No preference'],
    ['Start', l.start_date ?? '—'],
    ['Language', LANGUAGE_LABEL[l.language as keyof typeof LANGUAGE_LABEL] ?? l.language],
    ['WhatsApp updates', l.whatsapp_opt_in ? 'Yes' : 'No'],
    ['Consent to contact', l.consent_at ? istDateTime(l.consent_at) : 'Not recorded'],
    ['Notes', l.notes ?? '—'],
  ];
  if (l.status === 'lost') facts.push(['Lost reason', l.lost_reason ?? '—']);
  const placed = Boolean(l.customer_id);

  return (
    <main className="mx-auto max-w-6xl p-4 md:p-8">
      <Link href="/admin/leads" className="text-sm text-ink-500 hover:underline">← Leads</Link>
      <PageHeader
        title={l.name || 'No name'}
        subtitle={<>Created {istDateTime(l.created_at)} · <Badge tone={LEAD_STATUS_TONE[l.status]}>{LEAD_STATUS_LABEL[l.status]}</Badge>{l.chosen_kitchen ? ` · ${l.chosen_kitchen}` : ''}</>}
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card title="Details">
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              {facts.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3 border-b border-ink-100 py-1.5 sm:block sm:border-0 sm:py-0">
                  <dt className="text-ink-500">{k}</dt>
                  <dd className="text-ink-900">{v}</dd>
                </div>
              ))}
            </dl>
          </Card>

          <Card title={`Shortlist shown (${l.kitchens.length})`}>
            {l.kitchens.length ? (
              <ul className="divide-y divide-ink-100 text-sm">
                {l.kitchens.map((k) => (
                  <li key={k.kitchen_id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      <span className="font-medium">{k.name}</span>
                      <span className="text-ink-500"> · {k.area} · {Number(k.distance_km).toFixed(1)} km · {ratingLabel(k.rating, k.reviews)}</span>
                    </span>
                    <span className="text-ink-700">
                      {k.plan_name} · {formatPaise(k.price_per_meal_paise)}/meal
                      {l.chosen_kitchen_id === k.kitchen_id && <span className="ml-2"><Badge tone="green">Picked</Badge></span>}
                    </span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-ink-500">No kitchen matched (not qualified yet, or no active kitchen with space within its radius).</p>}
          </Card>

          <Card title="Nearby kitchens (within 8 km)">
            {l.nearby.length ? (
              <table className="min-w-full text-sm">
                <thead className="text-left text-xs uppercase text-ink-500">
                  <tr><th className="py-1">Kitchen</th><th className="py-1">Status</th><th className="py-1">Distance</th><th className="py-1">Delivers within</th></tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {l.nearby.map((k) => (
                    <tr key={k.kitchen_id}>
                      <td className="py-1.5 font-medium">{k.name}</td>
                      <td className="py-1.5"><Badge tone={k.status === 'active' ? 'green' : k.status === 'suspended' ? 'red' : 'gray'}>{k.status === 'active' ? 'Listed' : k.status}</Badge></td>
                      <td className="py-1.5">{k.distance_km} km</td>
                      <td className={`py-1.5 ${Number(k.distance_km) > Number(k.radius_km) ? 'text-amber-700' : ''}`}>
                        {k.radius_km} km{Number(k.distance_km) > Number(k.radius_km) ? ' (outside)' : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="text-sm text-ink-500">{l.lat == null ? 'No location yet, so distances are unknown.' : 'No kitchen within 8 km. Recruit one here.'}</p>}
          </Card>
        </div>

        <div className="space-y-6">
          <Card title="Actions">
            <LeadActions
              leadId={l.id}
              status={l.status}
              placed={placed}
              kitchens={l.nearby.filter((k) => k.status === 'active')}
            />
          </Card>
          <Card title="Timeline">
            <ol className="space-y-3 border-l border-ink-200 pl-4 text-sm">
              {l.events.map((e, i) => (
                <li key={i} className="relative">
                  <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full bg-brand-500" aria-hidden />
                  <div className="text-ink-900">{eventText(e)}</div>
                  <div className="text-xs text-ink-500">{istDateTime(e.at)}</div>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </main>
  );
}
