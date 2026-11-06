'use client';

import { useCallback, useEffect, useState } from 'react';
import { SLOT_LABEL, formatPaise } from '@tiffin/core';
import type { MealSlot } from '@tiffin/db';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { refreshRider } from '@/lib/rider-store';

type Unassigned = { id: string; route_id: string; route_name: string; slot: MealSlot; stops: number; kitchen_name: string };
type Mine = { kitchen_id: string; kitchen_name: string; pending_count: number; pending_paise: number; confirmed_paise: number;
  pending: { payment_id: string; customer_name: string; amount_paise: number }[] };

/**
 * Above the rider app (audit item 25), online only: owners take today's runs that have no rider
 * ("always me" also makes them the route's rider); everyone sees the door cash they still hold.
 */
export function RiderDesk({ userId, isOwner }: { userId: string; isOwner: boolean }) {
  const [runs, setRuns] = useState<Unassigned[]>([]);
  const [mine, setMine] = useState<Mine[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    const sb = supabaseBrowser();
    const [u, c] = await Promise.all([isOwner ? sb.rpc('unassigned_runs') : Promise.resolve({ data: [], error: null }), sb.rpc('my_cash_handover')]);
    if (!u.error) setRuns((u.data ?? []) as unknown as Unassigned[]);
    if (!c.error) setMine((c.data ?? []) as unknown as Mine[]);
  }, [isOwner]);

  useEffect(() => {
    const sb = supabaseBrowser();
    void Promise.all([isOwner ? sb.rpc('unassigned_runs') : Promise.resolve({ data: [], error: null }), sb.rpc('my_cash_handover')])
      .then(([u, c]) => {
        if (!u.error) setRuns((u.data ?? []) as unknown as Unassigned[]);
        if (!c.error) setMine((c.data ?? []) as unknown as Mine[]);
      });
  }, [isOwner]);

  async function take(run: Unassigned, always: boolean) {
    setBusy(run.id);
    setError('');
    const sb = supabaseBrowser();
    const r = await sb.rpc('assign_run', { p_run: run.id, p_rider: userId });
    const e = r.error ?? (always ? (await sb.rpc('update_route', { p_route: run.route_id, p_rider: userId })).error : null);
    setBusy(null);
    if (e) setError(friendlyError(e));
    await refreshRider();
    await load();
  }

  const held = mine.filter((m) => m.pending_count > 0);
  if (!runs.length && !held.length && !error) return null;
  return (
    <div className="space-y-3" data-testid="rider-desk">
      {runs.length > 0 && (
        <section className="rounded-xl border border-amber-200 bg-amber-50 p-3">
          <h2 className="text-sm font-semibold text-ink-900">Runs without a rider today</h2>
          <ul className="mt-2 space-y-2">
            {runs.map((r) => (
              <li key={r.id} className="space-y-1">
                <div className="text-sm text-ink-800">{SLOT_LABEL[r.slot]} · {r.route_name} · {r.stops} stop(s) <span className="text-xs text-ink-500">{r.kitchen_name}</span></div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" disabled={busy === r.id} onClick={() => take(r, false)}
                    className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">I will deliver this</button>
                  <button type="button" disabled={busy === r.id} onClick={() => take(r, true)}
                    className="rounded-lg bg-white px-3 py-2 text-sm font-medium text-ink-800 ring-1 ring-ink-200 disabled:opacity-50">Always me for {r.route_name}</button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {held.length > 0 && (
        <section className="rounded-xl border border-ink-200 bg-white p-3">
          <button type="button" className="flex w-full items-center justify-between text-left text-sm font-semibold text-ink-900" onClick={() => setOpen((v) => !v)}>
            <span>Cash with you: {formatPaise(held.reduce((t, m) => t + m.pending_paise, 0))}</span>
            <span className="text-xs text-brand-700">{open ? 'Hide' : 'Show'}</span>
          </button>
          {open && (
            <ul className="mt-2 space-y-1 text-sm text-ink-700">
              {held.flatMap((m) => m.pending.map((p) => (
                <li key={p.payment_id}>{p.customer_name}: {formatPaise(p.amount_paise)}{held.length > 1 ? ` · ${m.kitchen_name}` : ''}</li>
              )))}
              <li className="pt-1 text-xs text-ink-500">Hand this to the owner; it disappears here once they confirm it.</li>
            </ul>
          )}
        </section>
      )}
      {error && <p className="text-sm text-red-700">{error}</p>}
    </div>
  );
}
