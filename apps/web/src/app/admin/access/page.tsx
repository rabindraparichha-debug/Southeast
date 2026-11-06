import type { Metadata } from 'next';
import Link from 'next/link';
import type { AdminActionRow } from '@tiffin/db';
import { requireAdmin } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { istDateTime } from '@/lib/public';
import { Badge, Card, PageHeader } from '@/components/ui';
import { ActionList } from '../action-list';
import { AddAdminForm, AllowPhoneForm, OpenSignupToggle, RemoveAdmin, RemoveAllowedPhone, ResolveCloseRequest } from './access-forms';

export const metadata: Metadata = { title: 'Access · Admin' };

type AllowedPhone = { id: string; phone: string; note: string; created_at: string; added_by_last4: string | null; kitchen: { id: string; name: string } | null };
type PlatformAdmin = { user_id: string; name: string | null; phone: string | null; since: string; last_sign_in_at: string | null; is_me: boolean };
type CloseRequest = { id: string; kitchen_id: string; kitchen: string; kitchen_status: string; reason: string | null; created_at: string; requested_by_last4: string | null };

// Who may create kitchens (D-131), who runs the platform, kitchens asking to close, and the log of
// everything the platform team did.
export default async function AdminAccessPage() {
  await requireAdmin();
  const supabase = await createClient();
  const [{ data: flag }, { data: phones }, { data: admins }, { data: closes }, { data: actions }] = await Promise.all([
    supabase.from('platform_settings').select('enabled').eq('key', 'open_vendor_signup').maybeSingle(),
    supabase.rpc('admin_vendor_phones'),
    supabase.rpc('admin_platform_admins'),
    supabase.rpc('admin_close_requests', { p_status: 'open' }),
    supabase.rpc('admin_actions_list', { p_limit: 50 }),
  ]);
  const allowed = (phones ?? []) as unknown as AllowedPhone[];
  const adminList = (admins ?? []) as unknown as PlatformAdmin[];
  const closeList = (closes ?? []) as unknown as CloseRequest[];
  const log = (actions ?? []) as unknown as (AdminActionRow & { kitchen: string | null })[];

  return (
    <main className="mx-auto max-w-5xl space-y-4 p-4 md:p-8">
      <PageHeader title="Access" subtitle="Who may create a kitchen, who runs the platform, and what the team did. Every change here is logged with its reason." />

      <Card title="New kitchens">
        <p className="mb-3 text-sm text-ink-600">
          A number may create a kitchen once you approve its <Link href="/admin/vendors" className="text-brand-700 hover:underline">application</Link> or
          add it below. Owners of an existing kitchen and platform admins always may.
        </p>
        <OpenSignupToggle enabled={Boolean(flag?.enabled)} />
        <div className="mt-4 border-t border-ink-100 pt-4">
          <AllowPhoneForm />
        </div>
        <ul className="mt-4 divide-y divide-ink-100 text-sm">
          {allowed.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div>
                <span className="font-mono">{p.phone}</span> · {p.note}
                <div className="text-xs text-ink-500">
                  added {istDateTime(p.created_at)}{p.added_by_last4 ? ` by ••${p.added_by_last4}` : ''}
                  {p.kitchen && <> · created <Link href={`/admin/kitchens/${p.kitchen.id}`} className="text-brand-700 hover:underline">{p.kitchen.name}</Link></>}
                </div>
              </div>
              <RemoveAllowedPhone id={p.id} />
            </li>
          ))}
          {!allowed.length && <li className="py-2 text-ink-500">No numbers added yet.</li>}
        </ul>
      </Card>

      <Card title="Kitchens asking to close">
        <ul className="divide-y divide-ink-100 text-sm">
          {closeList.map((r) => (
            <li key={r.id} className="py-2">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/admin/kitchens/${r.kitchen_id}`} className="font-medium text-brand-700 hover:underline">{r.kitchen}</Link>
                <Badge>{r.kitchen_status}</Badge>
                <span className="text-xs text-ink-500">asked {istDateTime(r.created_at)}{r.requested_by_last4 ? ` by ••${r.requested_by_last4}` : ''}</span>
              </div>
              {r.reason && <p className="text-ink-700">“{r.reason}”</p>}
              <p className="text-xs text-ink-500">Nothing is deleted automatically: send the export, suspend the kitchen if asked, then record the outcome.</p>
              <ResolveCloseRequest id={r.id} />
            </li>
          ))}
          {!closeList.length && <li className="py-2 text-ink-500">No open requests.</li>}
        </ul>
      </Card>

      <Card title="Platform admins">
        <ul className="divide-y divide-ink-100 text-sm">
          {adminList.map((a) => (
            <li key={a.user_id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div>
                <span className="font-medium">{a.name ?? 'No name'}</span> {a.is_me && <Badge tone="green">You</Badge>} <span className="font-mono text-ink-600">{a.phone}</span>
                <div className="text-xs text-ink-500">since {istDateTime(a.since)} · last login {a.last_sign_in_at ? istDateTime(a.last_sign_in_at) : 'never'}</div>
              </div>
              {adminList.length > 1 && <RemoveAdmin userId={a.user_id} isMe={a.is_me} />}
            </li>
          ))}
        </ul>
        {adminList.length < 2 && <p className="mt-2 text-sm text-amber-700">Add a second admin, so one lost SIM cannot lock the team out.</p>}
        <div className="mt-4 border-t border-ink-100 pt-4"><AddAdminForm /></div>
      </Card>

      <Card title="Recent platform team actions">
        <ActionList actions={log} showKitchen />
      </Card>
    </main>
  );
}
