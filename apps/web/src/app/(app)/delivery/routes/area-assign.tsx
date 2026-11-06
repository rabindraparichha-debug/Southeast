'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { SLOT_LABEL } from '@tiffin/core';
import type { MealSlot } from '@tiffin/db';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Alert, Button, Card, Input, Select } from '@/components/ui';
import type { RiderOption } from './routes-manager';

type Area = { area: string; key: string; addresses: number; routes: { route_id: string; name: string }[] };
type AreaData = { areas: Area[]; routes: { id: string; name: string; rider_id: string | null }[] };
type Report = { rules: { area: string; route: string; created: boolean; addresses: number; moved: number }[]; rebuilt_slots?: number; rebuild_failed?: number };

/**
 * Routes by area (audit item 25): put every customer of an area on a route in one step, instead of
 * moving stops one by one on the live board. New route names create the route. Preview first.
 */
export function AreaAssign({ kitchenId, riders }: { kitchenId: string; riders: RiderOption[] }) {
  const router = useRouter();
  const [slot, setSlot] = useState<MealSlot>('lunch');
  const [data, setData] = useState<AreaData | null>(null);
  const [plan, setPlan] = useState<Record<string, { route: string; rider: string }>>({});
  const [preview, setPreview] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'red' | 'green'; text: string } | null>(null);

  const load = useCallback(async (s: MealSlot) => {
    const { data: d, error } = await supabaseBrowser().rpc('area_routes', { p_kitchen: kitchenId, p_slot: s });
    if (error) {
      setMsg({ tone: 'red', text: friendlyError(error) });
      return;
    }
    const next = d as unknown as AreaData;
    setData(next);
    setPreview(null);
    // Start from where each area is today (its single route, if it has one).
    setPlan(Object.fromEntries(next.areas.map((a) => [a.key, { route: a.routes.length === 1 ? a.routes[0]!.name : '', rider: '' }])));
  }, [kitchenId]);

  useEffect(() => {
    void supabaseBrowser().rpc('area_routes', { p_kitchen: kitchenId, p_slot: 'lunch' }).then(({ data: d, error }) => {
      if (error) return setMsg({ tone: 'red', text: friendlyError(error) });
      const next = d as unknown as AreaData;
      setData(next);
      setPlan(Object.fromEntries(next.areas.map((a) => [a.key, { route: a.routes.length === 1 ? a.routes[0]!.name : '', rider: '' }])));
    });
  }, [kitchenId]);

  const rules = (data?.areas ?? [])
    .filter((a) => a.key && plan[a.key]?.route.trim())
    .map((a) => ({ area: a.area, route: plan[a.key]!.route.trim(), ...(plan[a.key]!.rider ? { rider_id: plan[a.key]!.rider } : {}) }));

  async function submit(dryRun: boolean) {
    if (!rules.length) return;
    setBusy(true);
    setMsg(null);
    const { data: r, error } = await supabaseBrowser().rpc('assign_routes_by_area', {
      p_kitchen: kitchenId, p_slot: slot, p_rules: rules, p_dry_run: dryRun,
    });
    setBusy(false);
    if (error) return setMsg({ tone: 'red', text: friendlyError(error) });
    const report = r as unknown as Report;
    if (dryRun) {
      setPreview(report);
      return;
    }
    const moved = report.rules.reduce((t, x) => t + x.moved, 0);
    setMsg({
      tone: 'green',
      text: `${moved} address(es) moved. Each route got a fresh order.${report.rebuilt_slots ? ' Today’s locked runs were updated.' : ''}`
        + (report.rebuild_failed ? ' Some runs could not be updated: use “Plan / refresh runs” on the live board.' : ''),
    });
    router.refresh();
    await load(slot);
  }

  const routeNames = data?.routes.map((r) => r.name) ?? [];
  return (
    <Card title="Routes by area">
      <p className="mb-3 text-sm text-ink-600">
        Give each area a route (type a new name to create one). Every customer of that area moves to it, for this meal.
      </p>
      <div className="mb-3 flex gap-2">
        {(['lunch', 'dinner'] as const).map((s) => (
          <Button key={s} variant={s === slot ? 'primary' : 'secondary'} onClick={() => { setSlot(s); void load(s); }} disabled={busy}>
            {SLOT_LABEL[s]}
          </Button>
        ))}
      </div>
      {msg && <div className="mb-3"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
      {!data ? (
        <div className="h-24 animate-pulse rounded-lg bg-ink-100" />
      ) : data.areas.length === 0 ? (
        <p className="text-sm text-ink-500">No customers for {SLOT_LABEL[slot].toLowerCase()} yet.</p>
      ) : (
        <>
          <datalist id={`routes-${slot}`}>{routeNames.map((n) => <option key={n} value={n} />)}</datalist>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="area-table">
              <thead>
                <tr className="text-left text-xs text-ink-500">
                  <th className="py-1 pr-2">Area</th>
                  <th className="py-1 pr-2">Addresses</th>
                  <th className="py-1 pr-2">Route</th>
                  <th className="py-1">Rider (optional)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {data.areas.map((a) => (
                  <tr key={a.key || 'none'}>
                    <td className="py-2 pr-2 font-medium text-ink-900">{a.area || <span className="text-ink-400">No area</span>}</td>
                    <td className="py-2 pr-2 text-ink-600">
                      {a.addresses}
                      {a.routes.length > 1 && <span className="block text-xs text-ink-500">on {a.routes.map((r) => r.name).join(', ')}</span>}
                    </td>
                    <td className="py-2 pr-2">
                      {a.key ? (
                        <Input list={`routes-${slot}`} aria-label={`Route for ${a.area}`} value={plan[a.key]?.route ?? ''} className="min-w-32"
                          onChange={(e) => setPlan({ ...plan, [a.key]: { route: e.target.value, rider: plan[a.key]?.rider ?? '' } })} />
                      ) : <span className="text-xs text-ink-500">Add an area to these addresses first</span>}
                    </td>
                    <td className="py-2">
                      {a.key && (
                        <Select aria-label={`Rider for ${a.area}`} value={plan[a.key]?.rider ?? ''} className="min-w-32"
                          onChange={(e) => setPlan({ ...plan, [a.key]: { route: plan[a.key]?.route ?? '', rider: e.target.value } })}>
                          <option value="">Keep</option>
                          {riders.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                        </Select>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview && (
            <ul className="mt-3 space-y-1 rounded-lg bg-ink-50 p-3 text-sm text-ink-700" data-testid="area-preview">
              {preview.rules.map((r) => (
                <li key={`${r.area}-${r.route}`}>
                  {r.area} → {r.route}{r.created ? ' (new route)' : ''}: {r.moved} of {r.addresses} address(es) move
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => submit(true)} disabled={busy || !rules.length}>Preview</Button>
            <Button onClick={() => submit(false)} disabled={busy || !rules.length || !preview}>Apply</Button>
          </div>
        </>
      )}
    </Card>
  );
}
