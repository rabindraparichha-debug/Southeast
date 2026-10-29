'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { formatKm, type OptimizeResult, type RoutePoint, type RoutePoints } from '@/lib/delivery';
import { Alert, Badge, Button, Card } from '@/components/ui';
import { SortableList } from '@/components/sortable-list';

type Item = RoutePoint & { id: string };

// Same estimate as the database (straight line x road factor 1.3), for a live preview while reordering.
function estimateKm(start: RoutePoints['kitchen'], stops: RoutePoint[]): number | null {
  if (start?.lat == null || start?.lng == null) return null;
  const rad = (d: number) => (d * Math.PI) / 180;
  let km = 0;
  let lat = start.lat;
  let lng = start.lng;
  for (const s of stops) {
    if (s.lat == null || s.lng == null) continue;
    const a = Math.sin(rad(s.lat - lat) / 2) ** 2 + Math.cos(rad(lat)) * Math.cos(rad(s.lat)) * Math.sin(rad(s.lng - lng) / 2) ** 2;
    km += 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(a)));
    lat = s.lat;
    lng = s.lng;
  }
  return km * 1.3;
}

const toItems = (p: RoutePoints): Item[] => p.stops.map((s) => ({ ...s, id: s.address_id }));

export function RouteEditor({ initial, slotLabel }: { initial: RoutePoints; slotLabel: string }) {
  const router = useRouter();
  const [points, setPoints] = useState(initial);
  const [items, setItems] = useState<Item[]>(() => toItems(initial));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'red' | 'green' | 'amber'; text: string } | null>(null);

  async function reload() {
    const { data, error } = await supabaseBrowser().rpc('route_points', { p_route: initial.route_id });
    if (error) return setMsg({ tone: 'red', text: friendlyError(error) });
    const p = data as unknown as RoutePoints;
    setPoints(p);
    setItems(toItems(p));
    setDirty(false);
  }

  async function save() {
    setBusy(true);
    const { error } = await supabaseBrowser().rpc('save_route_order', { p_route: initial.route_id, p_address_ids: items.map((i) => i.address_id) });
    setBusy(false);
    if (error) return setMsg({ tone: 'red', text: friendlyError(error) });
    setMsg({ tone: 'green', text: 'Order saved. Today’s planned runs and the next days follow it.' });
    await reload();
    router.refresh();
  }

  async function optimise() {
    if (dirty && !window.confirm('Optimising replaces the order, including your unsaved changes. Continue?')) return;
    setBusy(true);
    setMsg(null);
    const supabase = supabaseBrowser();
    // Prefer the Edge Function (VROOM when configured); fall back to the built-in optimiser.
    let result: OptimizeResult | null = null;
    try {
      const { data, error } = await supabase.functions.invoke<OptimizeResult>('route-optimize', { body: { route_id: initial.route_id } });
      if (!error && data && typeof data.km_after === 'number') result = data;
    } catch {
      // network error: fall back below
    }
    if (!result) {
      const { data, error } = await supabase.rpc('optimize_route', { p_route: initial.route_id });
      if (error) {
        setBusy(false);
        return setMsg({ tone: 'red', text: friendlyError(error) });
      }
      result = data as unknown as OptimizeResult;
    }
    setBusy(false);
    const saved = Number(result.km_before) - Number(result.km_after);
    setMsg({
      tone: 'green',
      text: `Optimised${result.engine === 'vroom' ? ' (road network)' : ''}: ${formatKm(result.km_before)} → ${formatKm(result.km_after)}${
        saved > 0.05 ? `, ${saved.toFixed(1)} km shorter` : ' (already the shortest we found)'}.`,
    });
    await reload();
    router.refresh();
  }

  const noPin = items.filter((i) => i.lat == null || i.lng == null).length;
  const km = estimateKm(points.kitchen, items);

  return (
    <Card
      title={<span>{points.name} <span className="font-normal text-ink-500">· {slotLabel}</span></span>}
      actions={
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={optimise} disabled={busy || items.length < 2}>Optimise</Button>
          <Button onClick={save} disabled={busy || !dirty}>Save order</Button>
        </div>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm text-ink-600">
        <span>{items.length} stop(s)</span>
        {km != null && <span data-testid="route-km">≈ {formatKm(km)} from the kitchen</span>}
        {dirty && <Badge tone="amber">Unsaved changes</Badge>}
        {noPin > 0 && <span className="text-amber-700">{noPin} without a map pin (kept at the end)</span>}
      </div>
      {msg && <div className="mb-3"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
      {items.length === 0 ? (
        <p className="text-sm text-ink-500">No stops yet. Customers are added when runs are planned.</p>
      ) : (
        <SortableList
          items={items}
          disabled={busy}
          label="stop"
          onReorder={(next) => {
            setItems(next);
            setDirty(true);
          }}
          renderItem={(s, i) => (
            <div className="flex items-center justify-between gap-2 text-sm" data-testid="route-stop">
              <div className="min-w-0">
                <span className="mr-2 inline-block w-5 text-right text-xs text-ink-500">{i + 1}</span>
                <span className="font-medium text-ink-900">{s.customer_name}</span>
                <span className="ml-2 text-xs text-ink-500">{[s.landmark, s.area].filter(Boolean).join(', ')}</span>
              </div>
              <span className="flex shrink-0 gap-1">
                {s.pinned && <Badge tone="blue">Placed by hand</Badge>}
                {(s.lat == null || s.lng == null) && <Badge tone="amber">No pin</Badge>}
              </span>
            </div>
          )}
        />
      )}
      <p className="mt-3 text-xs text-ink-500">
        Drag stops (or use ▲ ▼), then save. “Optimise” finds the shortest order from the kitchen and replaces hand-placed positions.
      </p>
    </Card>
  );
}
