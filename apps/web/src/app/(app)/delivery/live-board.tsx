'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { formatPaise } from '@tiffin/core';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import {
  FAIL_REASON_LABEL,
  GPS_WARN_M,
  RUN_STATUS_LABEL,
  RUN_STATUS_TONE,
  formatIstTime,
  formatKm,
  type BoardRider,
  type BoardRun,
  type BoardStop,
  type LiveBoard,
} from '@/lib/delivery';
import { Alert, Badge, Button, Card, Select } from '@/components/ui';
import { SortableList } from '@/components/sortable-list';
import type { MapRider, MapStop } from '@/components/delivery-map';

// Leaflet touches `window`, so the map only renders in the browser.
const DeliveryMap = dynamic(() => import('@/components/delivery-map'), {
  ssr: false,
  loading: () => <div className="h-72 animate-pulse rounded-lg bg-ink-100" />,
});

const POLL_MS = 15_000;
type Msg = { tone: 'red' | 'green' | 'amber'; text: string } | null;

export function LiveBoardView({ kitchenId, initial, isOwner }: { kitchenId: string; initial: LiveBoard; isOwner: boolean }) {
  const [board, setBoard] = useState<LiveBoard>(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [updatedAt, setUpdatedAt] = useState(() => new Date());
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});
  const [showMap, setShowMap] = useState(false);

  const refresh = useCallback(async () => {
    const { data, error } = await supabaseBrowser().rpc('live_board', {
      p_kitchen: kitchenId, p_date: initial.service_date, p_slot: initial.slot,
    });
    if (error) {
      setMsg({ tone: 'red', text: friendlyError(error) });
      return;
    }
    setBoard(data as unknown as LiveBoard);
    setUpdatedAt(new Date());
  }, [kitchenId, initial.service_date, initial.slot]);

  // Live updates while any rider is out.
  const anyOut = board.runs.some((r) => r.status === 'out');
  useEffect(() => {
    if (!anyOut) return;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [anyOut, refresh]);

  // Proof photos are private; owners get short-lived signed links.
  const photoPaths = useMemo(
    () => board.runs.flatMap((r) => r.stops.map((s) => s.photo_path)).filter((p): p is string => Boolean(p)),
    [board],
  );
  useEffect(() => {
    if (!isOwner) return;
    const missing = photoPaths.filter((p) => !photoUrls[p]);
    if (!missing.length) return;
    let cancelled = false;
    supabaseBrowser().storage.from('proofs').createSignedUrls(missing, 3600).then(({ data }) => {
      if (cancelled || !data) return;
      const add: Record<string, string> = {};
      for (const d of data) if (d.path && d.signedUrl) add[d.path] = d.signedUrl;
      setPhotoUrls((prev) => ({ ...prev, ...add }));
    });
    return () => {
      cancelled = true;
    };
  }, [isOwner, photoPaths, photoUrls]);

  async function act(p: PromiseLike<{ error: { message?: string; code?: string } | null }>, ok?: string) {
    setBusy(true);
    const { error } = await p;
    setMsg(error ? { tone: 'red', text: friendlyError(error) } : ok ? { tone: 'green', text: ok } : null);
    await refresh();
    setBusy(false);
    return !error;
  }

  async function planRuns() {
    setBusy(true);
    const { data, error } = await supabaseBrowser().rpc('plan_runs', {
      p_kitchen: kitchenId, p_date: board.service_date, p_slot: board.slot,
    });
    setMsg(error ? { tone: 'red', text: friendlyError(error) } : { tone: 'green', text: `Runs planned: ${data ?? 0} stop(s).` });
    await refresh();
    setBusy(false);
  }

  function reorder(run: BoardRun, stops: BoardStop[]) {
    // Optimistic: show the new order now, then save (the board reloads either way).
    const renumbered = stops.map((s, i) => ({ ...s, seq: i + 1 }));
    setBoard((b) => ({ ...b, runs: b.runs.map((r) => (r.id === run.id ? { ...r, stops: renumbered } : r)) }));
    void act(supabaseBrowser().rpc('reorder_run', { p_run: run.id, p_stop_ids: stops.map((s) => s.id) }), 'Order saved. Tomorrow’s run keeps it.');
  }

  const totals = board.runs.reduce(
    (t, r) => ({
      stops: t.stops + r.counts.stops, delivered: t.delivered + r.counts.delivered,
      failed: t.failed + r.counts.failed, meals: t.meals + r.counts.meals,
    }),
    { stops: 0, delivered: 0, failed: 0, meals: 0 },
  );

  const mapStops: MapStop[] = board.runs.flatMap((r) =>
    r.stops.filter((s) => s.lat != null && s.lng != null)
      .map((s) => ({ id: s.id, lat: s.lat!, lng: s.lng!, status: s.status, label: `${r.route_name} #${s.seq} · ${s.customer_name}` })),
  );
  const mapRiders: MapRider[] = board.runs
    .filter((r) => r.status === 'out' && r.last_lat != null && r.last_lng != null)
    .map((r) => ({ id: r.id, lat: r.last_lat!, lng: r.last_lng!, label: `${r.rider_name ?? 'Rider'}${r.last_seen_at ? ` · ${formatIstTime(r.last_seen_at)}` : ''}` }));
  const kitchenPoint = board.kitchen?.lat != null && board.kitchen?.lng != null ? { lat: board.kitchen.lat, lng: board.kitchen.lng } : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm text-ink-600">
          {board.locked ? <Badge tone="gray">Count locked</Badge> : <Badge tone="blue">Not locked yet</Badge>}
          <span>
            {board.runs.length} run(s) · {totals.stops} stops · {totals.meals} meals · {totals.delivered} delivered
            {totals.failed ? ` · ${totals.failed} failed` : ''}
          </span>
          {board.unassigned > 0 && <Badge tone="amber">{board.unassigned} order(s) not in a run</Badge>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-ink-500" data-testid="updated-at">
            {anyOut ? 'Live · ' : ''}Updated {formatIstTime(updatedAt)}
          </span>
          <Button variant="ghost" onClick={() => void refresh()} disabled={busy}>Refresh</Button>
          {mapStops.length > 0 && (
            <Button variant="secondary" onClick={() => setShowMap((v) => !v)}>{showMap ? 'Hide map' : 'Map'}</Button>
          )}
          <Button variant="secondary" onClick={planRuns} disabled={busy}>Plan / refresh runs</Button>
        </div>
      </div>

      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {!board.locked && (
        <p className="text-xs text-ink-500">Runs are built automatically when the count locks. Planning earlier gives a draft that is re-synced at the lock.</p>
      )}

      {showMap && <DeliveryMap kitchen={kitchenPoint} stops={mapStops} riders={mapRiders} />}

      {board.runs.length === 0 ? (
        <Card>
          <p className="text-sm text-ink-600">
            No runs for this meal yet.{board.unassigned > 0 ? ' Use “Plan / refresh runs” to build them now.' : ''}
          </p>
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {board.runs.map((run) => (
            <RunCard
              key={run.id}
              run={run}
              riders={board.riders}
              otherRuns={board.runs.filter((r) => r.id !== run.id && r.status !== 'done')}
              isOwner={isOwner}
              busy={busy}
              photoUrls={photoUrls}
              onAssign={(rider) =>
                act(supabaseBrowser().rpc('assign_run', { p_run: run.id, p_rider: (rider || null) as string }), 'Rider updated for this day.')
              }
              onReorder={(stops) => reorder(run, stops)}
              onMove={(stopId, toRun) => act(supabaseBrowser().rpc('move_stop', { p_stop: stopId, p_run: toRun }), 'Stop moved. It stays on that route from now on.')}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RunCard({
  run, riders, otherRuns, isOwner, busy, photoUrls, onAssign, onReorder, onMove,
}: {
  run: BoardRun;
  riders: BoardRider[];
  otherRuns: BoardRun[];
  isOwner: boolean;
  busy: boolean;
  photoUrls: Record<string, string>;
  onAssign: (riderId: string) => void;
  onReorder: (stops: BoardStop[]) => void;
  onMove: (stopId: string, runId: string) => void;
}) {
  const c = run.counts;
  const pct = (n: number) => (c.stops ? `${(n * 100) / c.stops}%` : '0%');
  const riderKnown = !run.rider_id || riders.some((r) => r.user_id === run.rider_id);
  const closed = run.status === 'done';
  const cash = run.stops.reduce((t, s) => t + (s.cash_paise ?? 0), 0);

  return (
    <Card
      className="min-w-0"
      title={
        <span className="flex items-center gap-2 whitespace-nowrap">
          {run.route_name}
          <Badge tone={RUN_STATUS_TONE[run.status]}>{RUN_STATUS_LABEL[run.status]}</Badge>
        </span>
      }
      actions={
        <div className="w-48 shrink-0">
        <Select
          aria-label={`Rider for ${run.route_name}`}
          value={run.rider_id ?? ''}
          disabled={busy || closed}
          onChange={(e) => onAssign(e.target.value)}
        >
          <option value="">No rider</option>
          {!riderKnown && <option value={run.rider_id!}>{run.rider_name ?? 'Former member'}</option>}
          {riders.map((r) => (
            <option key={r.user_id} value={r.user_id}>{r.name || 'Unnamed'}{r.role === 'owner' ? ' (owner)' : ''}</option>
          ))}
        </Select>
        </div>
      }
    >
      <div data-testid="run-card" data-run-id={run.id} className="space-y-3">
        <div className="flex h-2.5 overflow-hidden rounded-full bg-ink-100" role="img" aria-label={`${c.delivered} delivered, ${c.failed} failed, ${c.pending} pending`}>
          <div className="bg-green-500" style={{ width: pct(c.delivered) }} />
          <div className="bg-red-500" style={{ width: pct(c.failed) }} />
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-600">
          <span><strong className="text-ink-900">{c.delivered}</strong>/{c.stops} delivered</span>
          {c.failed > 0 && <span className="text-red-700">{c.failed} failed</span>}
          <span>{c.pending} pending</span>
          <span>{c.meals} meals</span>
          {c.delivered > 0 && <span>{c.proved}/{c.delivered} with proof</span>}
          <span>Planned {formatKm(run.planned_km)}</span>
          {run.started_at && <span>Out {formatIstTime(run.started_at)}</span>}
          {run.finished_at && <span>Done {formatIstTime(run.finished_at)}</span>}
          {run.status === 'out' && (
            <span className={run.last_seen_at ? '' : 'text-amber-700'}>
              {run.last_seen_at ? `Last seen ${formatIstTime(run.last_seen_at)}` : 'No location yet'}
            </span>
          )}
          {isOwner && cash > 0 && <span>Cash {formatPaise(cash)}</span>}
        </div>

        <SortableList
          items={run.stops}
          disabled={busy || closed}
          label="stop"
          onReorder={onReorder}
          renderItem={(s) => <StopRow stop={s} isOwner={isOwner} photoUrl={s.photo_path ? photoUrls[s.photo_path] : undefined}
            otherRuns={otherRuns} busy={busy} onMove={(to) => onMove(s.id, to)} />}
        />
        {!closed && run.stops.length > 1 && (
          <p className="text-xs text-ink-500">Drag stops (or use ▲ ▼) to change the order. The new order is saved to the route for the next days.</p>
        )}
      </div>
    </Card>
  );
}

const STATUS_ICON = {
  pending: <span className="text-ink-400" title="Pending">○</span>,
  delivered: <span className="text-green-600" title="Delivered">✓</span>,
  failed: <span className="text-red-600" title="Failed">✗</span>,
};

function Proof({ stop, isOwner, photoUrl }: { stop: BoardStop; isOwner: boolean; photoUrl?: string }) {
  if (stop.status !== 'delivered') return null;
  if (stop.proof_type === 'otp') {
    return stop.otp_ok ? <Badge tone="green">OTP ✓</Badge> : <Badge tone="red">Code wrong</Badge>;
  }
  if (stop.proof_type === 'photo' && stop.photo_path) {
    if (!isOwner) return <Badge tone="green">Photo</Badge>;
    return photoUrl ? (
      <a href={photoUrl} target="_blank" rel="noreferrer" className="text-xs font-medium text-brand-700 hover:underline">Photo ↗</a>
    ) : <Badge tone="green">Photo</Badge>;
  }
  return <Badge tone="amber">No proof</Badge>;
}

function StopRow({
  stop: s, isOwner, photoUrl, otherRuns, busy, onMove,
}: {
  stop: BoardStop;
  isOwner: boolean;
  photoUrl?: string;
  otherRuns: BoardRun[];
  busy: boolean;
  onMove: (runId: string) => void;
}) {
  const address = [s.line1, s.landmark, s.area].filter(Boolean).join(', ');
  return (
    <div className="flex flex-wrap items-start justify-between gap-2 text-sm" data-testid="stop-row" data-stop-id={s.id}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-5 text-right text-xs text-ink-500">{s.seq}</span>
          {STATUS_ICON[s.status]}
          <span className="font-medium text-ink-900" data-testid="stop-name">{s.customer_name}</span>
          {s.meal_count !== 1 && <span className="text-xs text-ink-500">× {s.meal_count}</span>}
          <Proof stop={s} isOwner={isOwner} photoUrl={photoUrl} />
          {s.done_at && <span className="text-xs text-ink-500">{formatIstTime(s.done_at)}</span>}
        </div>
        {address && <div className="ml-7 truncate text-xs text-ink-500">{address}</div>}
        <div className="mt-1 ml-7 flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {s.status === 'failed' && (
            <span className="text-red-700">
              {FAIL_REASON_LABEL[s.failed_reason ?? ''] ?? s.failed_reason}
              {s.failed_note ? `: ${s.failed_note}` : ''}
            </span>
          )}
          {s.status === 'failed' && s.kitchen_fault && <Badge tone="blue">Kitchen fault: credited</Badge>}
          {s.offline && (
            <span className="text-amber-700">
              Offline, synced later
              {[s.done_at && `done ${formatIstTime(s.done_at)}`, s.synced_at && `synced ${formatIstTime(s.synced_at)}`]
                .filter(Boolean).map((t) => ` · ${t}`).join('')}
            </span>
          )}
          {s.gps_distance_m != null && s.gps_distance_m > GPS_WARN_M && (
            <span className="text-amber-700">⚠ GPS {s.gps_distance_m.toLocaleString('en-IN')} m from the pin</span>
          )}
          {(s.tiffins_out > 0 || s.tiffins_returned > 0) && (
            <span className="text-ink-600">Tiffins out {s.tiffins_out} · back {s.tiffins_returned}</span>
          )}
          {isOwner && s.cash_paise != null && s.cash_paise > 0 && <span className="text-ink-700">Cash {formatPaise(s.cash_paise)}</span>}
        </div>
      </div>
      {s.status === 'pending' && otherRuns.length > 0 && (
        <select
          aria-label={`Move ${s.customer_name} to another run`}
          value=""
          disabled={busy}
          onChange={(e) => e.target.value && onMove(e.target.value)}
          className="rounded-lg py-1 pr-7 pl-2 text-xs ring-1 ring-ink-200"
        >
          <option value="">Move to…</option>
          {otherRuns.map((r) => <option key={r.id} value={r.id}>{r.route_name}</option>)}
        </select>
      )}
    </div>
  );
}
