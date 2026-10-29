import type { Metadata } from 'next';
import Link from 'next/link';
import { requireAdmin } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { CHECKLIST, type ChecklistItem } from '@/lib/checklist';
import { firstParam, istDateTime, SOURCE_LABEL, VENDOR_STATUS_LABEL, VENDOR_STATUS_TONE, type LeadSource, type VendorAppStatus } from '@/lib/public';
import { Badge, Card, PageHeader } from '@/components/ui';
import { RevealPhone } from '../reveal-phone';
import { ApplicationActions } from './application-actions';

export const metadata: Metadata = { title: 'Vendor applications · Admin' };

type Application = {
  id: string; name: string; phone: string; kitchen_name: string | null; area: string | null; subscribers_estimate: number | null;
  fssai_no: string | null; source: LeadSource; campaign: string | null; status: VendorAppStatus; kitchen_id: string | null;
  kitchen_slug: string | null; notes: string | null; nudges: number; created_at: string; demand_nearby: number;
  checklist: ChecklistItem[] | null;
};
const STATUSES = Object.keys(VENDOR_STATUS_LABEL) as VendorAppStatus[];

export default async function VendorApplicationsPage({ searchParams }: PageProps<'/admin/vendors'>) {
  await requireAdmin();
  const wanted = firstParam((await searchParams).status);
  const status = STATUSES.find((s) => s === wanted);
  const supabase = await createClient();
  const { data } = await supabase.rpc('admin_vendor_applications', { p_status: status });
  const apps = (Array.isArray(data) ? data : []) as unknown as Application[];

  return (
    <main className="mx-auto max-w-6xl p-4 md:p-8">
      <PageHeader title="Vendor applications" subtitle="Kitchen owners who asked to join. Applications follow the owner’s kitchen: sign-up → onboarding, listed → live." />
      <nav className="mb-4 flex flex-wrap gap-1 text-sm">
        {[undefined, ...STATUSES].map((s) => (
          <Link key={s ?? 'all'} href={s ? `/admin/vendors?status=${s}` : '/admin/vendors'}
            className={`rounded-full px-3 py-1 ring-1 ${status === s ? 'bg-ink-800 text-white ring-ink-800' : 'bg-white text-ink-700 ring-ink-200'}`}>
            {s ? VENDOR_STATUS_LABEL[s] : 'All'}
          </Link>
        ))}
      </nav>
      <div className="space-y-3">
        {apps.map((a) => {
          const list = a.checklist ?? [];
          const done = list.filter((i) => i.done).length;
          const live = list.find((i) => i.key === 'live')?.done;
          return (
            <Card key={a.id}>
              <div className="grid gap-4 lg:grid-cols-[1fr_1fr_320px]">
                <div className="space-y-1 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-base font-semibold">{a.name}</span>
                    <Badge tone={VENDOR_STATUS_TONE[a.status]}>{VENDOR_STATUS_LABEL[a.status]}</Badge>
                  </div>
                  <div><RevealPhone kind="vendor" id={a.id} masked={a.phone} /></div>
                  <div className="text-ink-700">{a.kitchen_name ?? 'Kitchen name not given'}{a.area ? ` · ${a.area}` : ''}</div>
                  <div className="text-ink-500">
                    {[a.subscribers_estimate != null ? `~${a.subscribers_estimate} customers` : null, a.fssai_no ? `FSSAI ${a.fssai_no}` : 'No FSSAI yet'].filter(Boolean).join(' · ')}
                  </div>
                  <div className="text-xs text-ink-500">
                    {SOURCE_LABEL[a.source]}{a.campaign ? ` / ${a.campaign}` : ''} · applied {istDateTime(a.created_at)} · {a.nudges} nudge{a.nudges === 1 ? '' : 's'} sent
                  </div>
                </div>
                <div className="space-y-2 text-sm">
                  <div>
                    <span className={a.demand_nearby ? 'font-medium text-amber-700' : 'text-ink-500'}>{a.demand_nearby} waiting lead{a.demand_nearby === 1 ? '' : 's'}</span>
                    <span className="text-ink-500"> within 3 km</span>
                  </div>
                  {a.kitchen_id ? (
                    <div>
                      <div className="text-ink-700">
                        Kitchen set up · {done}/{list.length} ready
                        {live && a.kitchen_slug && <> · <Link href={`/k/${a.kitchen_slug}`} className="text-brand-700 hover:underline" target="_blank">public page</Link></>}
                        {' · '}<Link href="/admin/kitchens" className="text-brand-700 hover:underline">kitchens</Link>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink-100">
                        <div className="h-full bg-brand-500" style={{ width: `${list.length ? Math.round((done / list.length) * 100) : 0}%` }} />
                      </div>
                      {done < list.length && (
                        <div className="mt-1 text-xs text-ink-500">Missing: {list.filter((i) => !i.done).map((i) => CHECKLIST[i.key]?.label ?? i.key).join(', ')}</div>
                      )}
                    </div>
                  ) : <div className="text-ink-500">Not signed up in the app yet.</div>}
                </div>
                <ApplicationActions id={a.id} status={a.status} notes={a.notes} />
              </div>
            </Card>
          );
        })}
        {!apps.length && <Card><p className="text-sm text-ink-500">No applications{status ? ` with status “${VENDOR_STATUS_LABEL[status]}”` : ''}.</p></Card>}
      </div>
    </main>
  );
}
