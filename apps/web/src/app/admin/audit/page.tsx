import type { Metadata } from 'next';
import Link from 'next/link';
import { requireAdmin } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { firstParam } from '@/lib/public';
import { Alert, Badge, PageHeader } from '@/components/ui';
import type { AuditRow } from '../types';

export const metadata: Metadata = { title: 'Audit log · Admin' };

const PAGE = 50;
const ACTIONS = ['INSERT', 'UPDATE', 'DELETE', 'ACCESS'] as const;
// Tables with private.audit_row() triggers, plus ones that log ACCESS (phone reveals).
const TABLES = [
  'addresses', 'broadcasts', 'complaints', 'consents', 'count_snapshots', 'customers', 'delivery_routes', 'delivery_runs',
  'delivery_stops', 'import_batches', 'items', 'kitchen_payout_accounts', 'kitchen_reviews', 'kitchen_settings', 'kitchens',
  'leads', 'member_invites', 'members', 'menus', 'payments', 'plans', 'platform_admins', 'purchase_lines', 'purchases',
  'recipe_lines', 'refunds', 'schedule_changes', 'stock_moves', 'stock_take_lines', 'subscriptions', 'supplier_payments',
  'tiffin_ledger', 'vendor_applications', 'balance_entries',
].sort();
const ACTION_TONE = { INSERT: 'green', UPDATE: 'blue', DELETE: 'red', ACCESS: 'amber' } as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

type Obj = Record<string, unknown>;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Keys whose value differs between before and after (all keys of the one present for INSERT/DELETE/ACCESS). */
function changedKeys(r: AuditRow): string[] {
  const b = (r.before ?? {}) as Obj;
  const a = (r.after ?? {}) as Obj;
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  if (r.action !== 'UPDATE') return keys;
  return keys.filter((k) => !same(b[k], a[k]));
}

const fmtTime = (at: string) => new Date(at).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: '2-digit', hour: 'numeric', minute: '2-digit', second: '2-digit',
});

function show(v: unknown): string {
  if (v === undefined) return '—';
  if (v === null) return 'null';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

export default async function AuditPage({ searchParams }: PageProps<'/admin/audit'>) {
  await requireAdmin();
  const sp = await searchParams;
  const kitchen = firstParam(sp.kitchen);
  const table = firstParam(sp.table);
  const action = firstParam(sp.action);
  const filters = {
    kitchen: kitchen && UUID.test(kitchen) ? kitchen : undefined,
    table: table && TABLES.includes(table) ? table : undefined,
    action: action && (ACTIONS as readonly string[]).includes(action) ? action : undefined,
  };
  // Cursor = (timestamp, id) of the last row shown.
  const beforeAt = firstParam(sp.before);
  const beforeId = Number(firstParam(sp.bid));
  const cursor = beforeAt && TS.test(beforeAt) && Number.isInteger(beforeId) && beforeId > 0 ? { at: beforeAt, id: beforeId } : null;

  const supabase = await createClient();
  const { data: kitchens } = await supabase.from('kitchens').select('id, name').order('name');

  const rpcArgs = { p_kitchen: filters.kitchen, p_table: filters.table, p_action: filters.action };
  // Keyset paging on (timestamp, id): rows written in one transaction share a timestamp.
  const { data, error } = await supabase.rpc('admin_audit_log', {
    ...rpcArgs, p_limit: PAGE + 1, ...(cursor ? { p_before: cursor.at, p_before_id: cursor.id } : {}),
  });
  const errorText = error?.message ?? '';
  let rows = (data ?? []) as unknown as AuditRow[];
  const hasMore = rows.length > PAGE;
  rows = rows.slice(0, PAGE);
  const last = rows.at(-1);

  const qs = (extra: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    Object.entries({ kitchen: filters.kitchen, table: filters.table, action: filters.action, ...extra }).forEach(([k, v]) => v && p.set(k, v));
    const s = p.toString();
    return `/admin/audit${s ? `?${s}` : ''}`;
  };
  const input = 'rounded-lg border-0 px-3 py-2 text-sm ring-1 ring-ink-200';

  return (
    <main className="mx-auto max-w-6xl p-4 md:p-8">
      <PageHeader
        title="Audit log"
        subtitle="Every change to money, counts, memberships and customer data, and every phone reveal. Phone numbers and tokens are never stored here."
      />
      <form action="/admin/audit" className="mb-4 flex flex-wrap items-end gap-2">
        <label className="space-y-1 text-sm">
          <span className="block text-ink-700">Kitchen</span>
          <select name="kitchen" defaultValue={filters.kitchen ?? ''} className={input}>
            <option value="">All kitchens</option>
            {(kitchens ?? []).map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span className="block text-ink-700">Table</span>
          <select name="table" defaultValue={filters.table ?? ''} className={input}>
            <option value="">All tables</option>
            {TABLES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span className="block text-ink-700">Action</span>
          <select name="action" defaultValue={filters.action ?? ''} className={input}>
            <option value="">All actions</option>
            {ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <button className="rounded-lg bg-white px-4 py-2 text-sm font-medium ring-1 ring-ink-200 hover:bg-ink-50">Filter</button>
        {(filters.kitchen || filters.table || filters.action) && <Link href="/admin/audit" className="px-2 py-2 text-sm text-brand-700 hover:underline">Clear</Link>}
      </form>

      {errorText && <Alert>{errorText}</Alert>}
      {filters.table === 'balance_entries' && (
        <div className="mb-3"><Alert tone="amber">The balance ledger is append-only and is not copied into the audit log; its rows are their own record (see the customer’s money tab). Payments and refunds are audited.</Alert></div>
      )}

      <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-ink-100">
        {cursor && <p className="border-b border-ink-100 px-4 py-2 text-xs text-ink-500">Showing entries older than {fmtTime(cursor.at)} · <Link href={qs({})} className="text-brand-700 hover:underline">Back to newest</Link></p>}
        <ul className="divide-y divide-ink-100 text-sm">
          {rows.map((r) => {
            const keys = changedKeys(r);
            const b = (r.before ?? {}) as Obj;
            const a = (r.after ?? {}) as Obj;
            return (
              <li key={r.id}>
                <details className="group">
                  <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 hover:bg-ink-50">
                    <span className="w-44 shrink-0 whitespace-nowrap tabular-nums text-ink-500">{fmtTime(r.at)}</span>
                    <Badge tone={ACTION_TONE[r.action] ?? 'gray'}>{r.action}</Badge>
                    <span className="font-mono text-xs text-ink-800">{r.table}</span>
                    <span className="text-ink-700">{r.kitchen ?? 'Platform'}</span>
                    <span className="text-xs text-ink-500">
                      {r.actor_role ?? 'system'}{r.actor_phone_last4 ? ` ··${r.actor_phone_last4}` : ''}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-ink-500">
                      {r.action === 'UPDATE' ? `changed: ${keys.join(', ') || 'nothing'}` : r.action === 'ACCESS' ? show(a.reason ?? '') : `${keys.length} fields`}
                    </span>
                    <span className="text-xs text-brand-700 group-open:hidden">Details</span>
                    <span className="hidden text-xs text-brand-700 group-open:inline">Hide</span>
                  </summary>
                  <div className="space-y-2 bg-ink-50 px-4 py-3">
                    <p className="text-xs text-ink-500">
                      Entry #{r.id} · row <span className="font-mono">{r.row_id ?? '—'}</span>{r.actor_id ? <> · actor <span className="font-mono">{r.actor_id}</span></> : null}
                    </p>
                    {keys.length > 0 ? (
                      <div className="overflow-x-auto">
                        <table className="min-w-full text-xs">
                          <thead className="text-left text-ink-500">
                            <tr><th className="py-1 pr-4">Field</th>{r.action !== 'INSERT' && r.action !== 'ACCESS' && <th className="py-1 pr-4">Before</th>}{r.action !== 'DELETE' && <th className="py-1">After</th>}</tr>
                          </thead>
                          <tbody className="font-mono">
                            {keys.map((k) => (
                              <tr key={k} className="align-top">
                                <td className="py-1 pr-4 font-sans font-medium text-ink-700">{k}</td>
                                {r.action !== 'INSERT' && r.action !== 'ACCESS' && <td className="max-w-xs break-all py-1 pr-4 text-red-800">{show(b[k])}</td>}
                                {r.action !== 'DELETE' && <td className="max-w-xs break-all py-1 text-green-800">{show(a[k])}</td>}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : <p className="text-xs text-ink-500">No field changes recorded.</p>}
                    {r.action === 'UPDATE' && (
                      <details className="text-xs">
                        <summary className="cursor-pointer text-brand-700">Full row before and after</summary>
                        <div className="mt-2 grid gap-2 md:grid-cols-2">
                          <pre className="overflow-x-auto rounded bg-white p-2 ring-1 ring-ink-100">{JSON.stringify(r.before, null, 2)}</pre>
                          <pre className="overflow-x-auto rounded bg-white p-2 ring-1 ring-ink-100">{JSON.stringify(r.after, null, 2)}</pre>
                        </div>
                      </details>
                    )}
                  </div>
                </details>
              </li>
            );
          })}
          {!rows.length && <li className="px-4 py-6 text-center text-ink-500">No audit entries match these filters.</li>}
        </ul>
      </div>
      <div className="mt-4 flex items-center justify-between text-sm">
        <span className="text-ink-500">{rows.length} entr{rows.length === 1 ? 'y' : 'ies'} on this page</span>
        {hasMore && last && (
          <Link href={qs({ before: last.at, bid: String(last.id) })} className="rounded-lg bg-white px-4 py-2 font-medium ring-1 ring-ink-200 hover:bg-ink-50">
            Older →
          </Link>
        )}
      </div>
    </main>
  );
}
