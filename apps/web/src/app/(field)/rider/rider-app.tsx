'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { formatIstShort, formatPaise, rupeesToPaise, SLOT_LABEL } from '@tiffin/core';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError, friendlyErrorIn } from '@/lib/errors';
import { downscaleJpeg } from '@/lib/image';
import {
  act, clearRiderError, discardAttention, isNetworkError, keepPhoto, loadRider, markOffline, refreshRider, retryAttention,
  useRider, uuid, type AttentionItem, type RiderRun, type RiderStop,
} from '@/lib/rider-store';
import { cashOf } from '@/lib/rider-queue';
import { BigButton, Chip, ErrorText, FieldInput, Muted, Panel, Stepper } from '@/components/field-ui';
import { ScanSticker } from './scan-sticker';

// Rider mode (web port of apps/mobile/src/app/(tabs)/rider.tsx and stop/[id].tsx). One page with two
// views (stop list, stop detail in the URL hash) so it keeps working offline without server round trips.

const REASONS = ['not_home', 'wrong_address', 'refused', 'unreachable', 'kitchen_late', 'food_issue', 'missing_meal', 'rider_issue', 'other'] as const;
type Reason = (typeof REASONS)[number];
const KITCHEN_FAULT = new Set<Reason>(['kitchen_late', 'food_issue', 'missing_meal', 'rider_issue']);
const REASON_LABEL: Record<Reason, string> = {
  not_home: 'Not at home',
  wrong_address: 'Wrong address',
  refused: 'Refused',
  unreachable: 'Phone not reachable',
  kitchen_late: 'Food was late',
  food_issue: 'Food problem',
  missing_meal: 'Meal missing',
  rider_issue: 'Vehicle / rider problem',
  other: 'Other',
};
const STATUS_LABEL = { pending: 'To deliver', delivered: 'Delivered', failed: 'Not delivered' } as const;
const STATUS_CLASS = { pending: 'text-ink-500', delivered: 'text-green-700', failed: 'text-red-700' } as const;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const address = (s: RiderStop) => [s.line1, s.landmark, s.area].filter(Boolean).join(', ');

/** Best-effort GPS fix: a recent position, else a quick fresh one. Never blocks for more than 6 s. */
function gps(): Promise<{ lat: number; lng: number; accuracy: number | null } | null> {
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 6000);
    try {
      navigator.geolocation.getCurrentPosition(
        (p) => {
          clearTimeout(timer);
          resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy ?? null });
        },
        () => {
          clearTimeout(timer);
          resolve(null);
        },
        { enableHighAccuracy: false, maximumAge: 60000, timeout: 6000 },
      );
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

async function geoGranted(): Promise<boolean> {
  try {
    const p = await navigator.permissions?.query({ name: 'geolocation' as PermissionName });
    return p?.state === 'granted';
  } catch {
    return false;
  }
}

// --- the stop shown in the URL hash (#stop=<id>) ---
const subscribeHash = (cb: () => void) => {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
};
const readStopId = () => (typeof location === 'undefined' ? null : /^#stop=([\w-]+)$/.exec(location.hash)?.[1] ?? null);

export function RiderApp({ userId, isOwner }: { userId: string; isOwner: boolean }) {
  const rider = useRider();
  const stopId = useSyncExternalStore(subscribeHash, readStopId, () => null);
  const openedHere = useRef(false);

  const openStop = (id: string) => {
    openedHere.current = true;
    location.hash = `stop=${id}`;
  };
  const closeStop = useCallback(() => {
    if (openedHere.current) {
      openedHere.current = false;
      history.back();
    } else {
      history.replaceState(history.state, '', location.pathname + location.search);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    }
  }, []);

  // Load the cache, then keep syncing: now, every 30 s, when the network returns and when the app
  // comes back to the front.
  useEffect(() => {
    void loadRider(userId).then(refreshRider);
    const timer = setInterval(() => void refreshRider(), 30000);
    const onOnline = () => void refreshRider();
    const onOffline = () => markOffline();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshRider();
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [userId]);

  if (!rider.loaded) return <Muted className="p-4">Loading…</Muted>;

  const found = stopId
    ? rider.runs.flatMap((run) => run.stops.filter((s) => s.id === stopId).map((stop) => ({ run, stop })))[0]
    : undefined;

  return (
    <div className="space-y-3">
      <SyncBanners />
      {stopId ? (
        found ? <StopView key={found.stop.id} run={found.run} stop={found.stop} onDone={closeStop} /> : (
          <Panel>
            <Muted>This stop is not in today&apos;s list any more.</Muted>
            <BigButton variant="secondary" onClick={closeStop}>← Back to stops</BigButton>
          </Panel>
        )
      ) : (
        <RunList isOwner={isOwner} onOpen={openStop} />
      )}
    </div>
  );
}

function SyncBanners() {
  const rider = useRider();
  const n = rider.queue.length;
  return (
    <>
      {!rider.online && (
        <div role="status" data-testid="offline-banner" className="rounded-xl bg-amber-100 px-3 py-2.5 text-sm font-medium text-amber-900 ring-1 ring-amber-200">
          Offline. {n} action{n === 1 ? '' : 's'} will sync when you are back online.
        </div>
      )}
      {rider.online && n > 0 && (
        <div role="status" data-testid="pending-banner" className="rounded-xl bg-brand-50 px-3 py-2.5 text-sm text-ink-800 ring-1 ring-brand-100">
          {n} action{n === 1 ? '' : 's'} waiting to sync…
        </div>
      )}
      {rider.lastError && (
        <button type="button" onClick={clearRiderError} className="block w-full rounded-xl bg-red-50 px-3 py-2.5 text-left text-sm text-red-800 ring-1 ring-red-200">
          Not synced yet, will try again: {friendlyErrorIn('rider', { message: rider.lastError })} <span className="text-red-500">(tap to hide)</span>
        </button>
      )}
      {rider.attention.length > 0 && <NeedsAttention items={rider.attention} runs={rider.runs} />}
    </>
  );
}

const KIND_LABEL = { start: 'Start run', complete: 'Delivered', fail: 'Not delivered', finish: 'Finish run', request: 'Customer request' } as const;

/** Actions the server refused: kept on this device with photo and cash until retried or discarded. */
function NeedsAttention({ items, runs }: { items: AttentionItem[]; runs: RiderRun[] }) {
  const stopName = (stopId?: string) => {
    for (const r of runs) {
      const s = r.stops.find((x) => x.id === stopId);
      if (s) return `${s.seq}. ${s.name}`;
    }
    return stopId ? 'a stop no longer in today’s list' : '';
  };
  const discard = (a: AttentionItem) => {
    if (window.confirm('Discard this? It is deleted from this phone, with its photo. Tell the kitchen about any cash you collected.')) {
      void discardAttention(a.op.op);
    }
  };
  return (
    <div className="space-y-2 rounded-xl bg-red-50 p-3 ring-1 ring-red-200" data-testid="needs-attention">
      <p className="text-base font-semibold text-red-800">⚠ Needs attention ({items.length})</p>
      <p className="text-sm text-red-900">The server did not accept these. They stay on this phone, with their photo and cash, until you try again or discard them.</p>
      <ul className="space-y-2">
        {items.map((a) => {
          const cash = cashOf(a.op);
          return (
            <li key={a.op.op} className="space-y-1 rounded-lg bg-white p-3 ring-1 ring-red-100">
              <p className="text-sm font-semibold text-ink-900">{KIND_LABEL[a.op.kind]}{a.op.stopId ? `: ${stopName(a.op.stopId)}` : ''}</p>
              <p className="text-sm text-ink-700">{friendlyErrorIn('rider', { message: a.reason })}</p>
              <p className="text-xs text-ink-500">
                {formatIstShort(a.op.at)}{cash > 0 ? ` · cash ${formatPaise(cash)}` : ''}{a.op.hasPhoto ? ' · photo kept' : ''}
              </p>
              <div className="grid grid-cols-2 gap-2">
                <BigButton variant="secondary" onClick={() => void retryAttention(a.op.op)} data-testid="attention-retry">Try again</BigButton>
                <BigButton variant="danger" onClick={() => discard(a)} data-testid="attention-discard">Discard</BigButton>
              </div>
            </li>
          );
        })}
      </ul>
      {items.length > 1 && <BigButton onClick={() => void retryAttention()}>Try all again</BigButton>}
    </div>
  );
}

function RunList({ isOwner, onOpen }: { isOwner: boolean; onOpen: (id: string) => void }) {
  const rider = useRider();
  const [runId, setRunId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);

  const run: RiderRun | undefined = useMemo(
    () => rider.runs.find((r) => r.id === runId) ?? rider.runs.find((r) => r.status !== 'done') ?? rider.runs[0],
    [rider.runs, runId],
  );

  // Live location for the kitchen's board while the run is out (online only, never queued).
  useEffect(() => {
    if (run?.status !== 'out') return;
    const id = run.id;
    let alive = true;
    const ping = async () => {
      if (!alive || !navigator.onLine || !(await geoGranted())) return;
      navigator.geolocation.getCurrentPosition(
        (p) => {
          if (alive) void supabaseBrowser().rpc('rider_ping', { p_run: id, p_lat: p.coords.latitude, p_lng: p.coords.longitude });
        },
        () => undefined,
        { maximumAge: 120000, timeout: 10000 },
      );
    };
    void ping();
    const timer = setInterval(() => void ping(), 60000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [run?.id, run?.status]);

  const refresh = async () => {
    setRefreshing(true);
    await refreshRider();
    setRefreshing(false);
  };

  if (!run) {
    return (
      <Panel>
        <p className="text-base text-ink-700" data-testid="no-runs">No deliveries assigned to you today.</p>
        {isOwner && <Muted>To deliver yourself, choose yourself as the rider of a route in Delivery → Routes. Your stops show here after the count is locked.</Muted>}
        <BigButton variant="secondary" onClick={refresh} disabled={refreshing}>{refreshing ? 'Refreshing…' : '↻ Refresh'}</BigButton>
      </Panel>
    );
  }

  const done = run.stops.filter((s) => s.status !== 'pending').length;
  const allDone = done === run.stops.length;
  const multiKitchen = rider.runs.some((x) => x.kitchen_id !== run.kitchen_id);

  const start = async () => {
    setBusy(true);
    await gps(); // asks for location permission now, so pings and proofs have it later
    await act({ kind: 'start', runId: run.id, args: {} });
    setBusy(false);
  };
  const finish = async () => {
    setBusy(true);
    await act({ kind: 'finish', runId: run.id, args: {} });
    setBusy(false);
  };

  return (
    <>
      {rider.runs.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {rider.runs.map((r) => (
            <Chip key={r.id} selected={r.id === run.id} onClick={() => setRunId(r.id)}
              label={`${SLOT_LABEL[r.slot]} · ${r.route_name}${multiKitchen ? ` · ${r.kitchen_name}` : ''}`} />
          ))}
        </div>
      )}

      <Panel>
        <div className="flex items-baseline justify-between gap-2">
          <h1 className="text-lg font-semibold text-ink-900">{SLOT_LABEL[run.slot]} · {run.route_name}</h1>
          {run.planned_km ? <span className="shrink-0 text-sm text-ink-500">~{run.planned_km} km</span> : null}
        </div>
        <p className="text-sm text-ink-600" data-testid="run-progress">{done} of {run.stops.length} stops</p>
        <div className="flex h-2 overflow-hidden rounded-full bg-ink-200" aria-hidden>
          <div className="bg-green-600" style={{ width: `${run.stops.length ? (done / run.stops.length) * 100 : 0}%` }} />
        </div>
        {run.status === 'planned' && (
          <>
            <BigButton onClick={start} disabled={busy} data-testid="start-run">{busy ? 'Starting…' : 'Start run'}</BigButton>
            <Muted>Tap when you leave the kitchen.</Muted>
          </>
        )}
        {run.status === 'out' && allDone && <BigButton onClick={finish} disabled={busy} data-testid="finish-run">Finish run</BigButton>}
        {run.status === 'done' && <p className="text-sm font-medium text-green-700" data-testid="run-done">Run finished</p>}
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-ink-500">{rider.fetchedAt ? `Updated ${formatIstShort(rider.fetchedAt)}` : ''}</span>
          <button type="button" onClick={refresh} disabled={refreshing || rider.syncing} className="text-sm font-medium text-brand-700 disabled:text-ink-400">
            {refreshing || rider.syncing ? 'Syncing…' : '↻ Refresh'}
          </button>
        </div>
      </Panel>

      <ul className="space-y-2">
        {run.stops.map((s) => <StopRow key={s.id} stop={s} onOpen={() => onOpen(s.id)} />)}
      </ul>
    </>
  );
}

function StopRow({ stop, onOpen }: { stop: RiderStop; onOpen: () => void }) {
  const changed = stop as RiderStop & { changed?: boolean; changed_at?: string | null };
  const diets = Object.entries(stop.diets ?? {}).map(([d, n]) => `${n} ${d === 'nonveg' ? 'non-veg' : d}`).join(', ');
  return (
    <li>
      <button type="button" onClick={onOpen} data-testid={`stop-row-${stop.seq}`}
        className={`flex w-full items-start gap-3 rounded-xl bg-white p-3 text-left shadow-sm ring-1 ring-ink-100 active:bg-ink-50 ${stop.status !== 'pending' ? 'opacity-60' : ''}`}>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-50 font-bold text-brand-700">{stop.seq}</span>
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="block text-base font-semibold text-ink-900">{stop.office ? '🏢 ' : ''}{stop.name}</span>
          {/* Wave 1 (rider_today.changed): added or changed after the run was built (late skip, new address, meal count). */}
          {changed.changed && stop.status === 'pending' && (
            <span className="inline-block rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800" data-testid={`stop-changed-${stop.seq}`}>
              Changed{changed.changed_at ? ` ${formatIstShort(changed.changed_at)}` : ''}: check meals and address
            </span>
          )}
          {stop.office && <span className="block text-xs font-medium text-brand-700">Office: hand all {plural(stop.meal_count, 'tiffin')} to reception</span>}
          <span className="block text-sm text-ink-600">{address(stop)}</span>
          <span className="block text-xs text-ink-500">
            {plural(stop.meal_count, 'meal')}{diets ? ` · ${diets}` : ''}
            {stop.tiffins_with_customer > 0 ? ` · has ${plural(stop.tiffins_with_customer, 'tiffin')} of ours` : ''}
          </span>
          {stop.delivery_notes ? <span className="block text-sm text-amber-800">Note: {stop.delivery_notes}</span> : null}
        </span>
        <span className="shrink-0 text-right">
          <span className={`block text-sm font-semibold ${STATUS_CLASS[stop.status]}`}>{STATUS_LABEL[stop.status]}</span>
          {stop.queued && <span className="block text-xs text-ink-500" title="Saved on this phone, will sync">⏳ queued</span>}
        </span>
      </button>
    </li>
  );
}

function StopView({ run, stop, onDone }: { run: RiderRun; stop: RiderStop; onDone: () => void }) {
  const rider = useRider();
  const [otp, setOtp] = useState('');
  const [tiffinsOut, setTiffinsOut] = useState<number | null>(null);
  const [tiffinsBack, setTiffinsBack] = useState<number | null>(null);
  const [cash, setCash] = useState('');
  const [failing, setFailing] = useState(false);
  const [reason, setReason] = useState<Reason | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [scanned, setScanned] = useState<string | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);

  const out = tiffinsOut ?? stop.meal_count;
  const back = tiffinsBack ?? Math.min(stop.tiffins_with_customer, stop.meal_count);
  const canAct = stop.status === 'pending' && run.status !== 'done';

  const dest = stop.lat != null && stop.lng != null
    ? `${stop.lat},${stop.lng}`
    : encodeURIComponent([stop.line1, stop.landmark, stop.area, 'Bhubaneswar'].filter(Boolean).join(', '));
  const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=two-wheeler`;

  const call = async () => {
    setError('');
    const { data, error: e } = await supabaseBrowser().rpc('rider_call_number', { p_stop: stop.id });
    if (e) return setError(isNetworkError(e) ? friendlyError({ message: 'call_offline' }) : friendlyErrorIn('rider', e));
    window.location.href = `tel:${data}`;
  };

  const cashPaise = (() => {
    const n = Number(cash.replace(/[^\d.]/g, ''));
    return cash.trim() && Number.isFinite(n) && n > 0 ? rupeesToPaise(n) ?? 0 : 0;
  })();

  const deliver = async (proof: 'otp' | 'photo' | 'none', photo?: Blob) => {
    setError('');
    if (proof === 'otp' && !/^\d{4}$/.test(otp.trim())) return setError(friendlyError({ message: 'otp_format' }));
    const op = uuid();
    let photoPath: string | undefined;
    setBusy(true);
    if (proof === 'photo') {
      if (!photo) {
        setBusy(false);
        return setError(friendlyError({ message: 'photo_required' }));
      }
      try {
        await keepPhoto(photo, op);
      } catch {
        setBusy(false);
        return setError(friendlyError({ message: 'photo_failed' }));
      }
      photoPath = `${run.kitchen_id}/${run.service_date}/${stop.id}-${op.slice(0, 8)}.jpg`;
    }
    const pos = await gps();
    const res = await act({
      op, kind: 'complete', runId: run.id, stopId: stop.id, hasPhoto: Boolean(photoPath), photoPath, scanToken: scanned ?? undefined,
      args: {
        p_proof: proof, p_otp: proof === 'otp' ? otp.trim() : null, p_lat: pos?.lat ?? null, p_lng: pos?.lng ?? null,
        p_accuracy: pos?.accuracy ?? null, p_tiffins_out: out, p_tiffins_returned: back, p_cash_paise: cashPaise,
      },
    });
    setBusy(false);
    if (res.otpWrong) return setError(friendlyError({ message: 'otp_wrong' }));
    if (res.error) {
      setScanned(null);
      void refreshRider(); // the stop was not saved: show the server's state again
      return setError(friendlyErrorIn('rider', { message: res.error }));
    }
    onDone();
  };

  const onPhoto = async (file: File | undefined) => {
    if (photoInput.current) photoInput.current.value = '';
    if (!file) return;
    setError('');
    let jpeg: Blob;
    try {
      jpeg = await downscaleJpeg(file, 1280, 0.72);
    } catch {
      return setError(friendlyError({ message: 'photo_failed' }));
    }
    await deliver('photo', jpeg);
  };

  const fail = async () => {
    setError('');
    if (!reason) return setError(friendlyError({ message: 'reason_required' }));
    if (reason === 'other' && !note.trim()) return setError(friendlyError({ message: 'note_required' }));
    setBusy(true);
    const pos = await gps();
    const res = await act({
      kind: 'fail', runId: run.id, stopId: stop.id,
      args: { p_reason: reason, p_note: note.trim() || null, p_lat: pos?.lat ?? null, p_lng: pos?.lng ?? null, p_tiffins_returned: back },
    });
    setBusy(false);
    if (res.error) return setError(friendlyErrorIn('rider', { message: res.error }));
    onDone();
  };

  return (
    <div className="space-y-3 pb-10">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onDone} className="rounded-lg px-2 py-2 text-sm font-medium text-brand-700" data-testid="back-to-stops">← Stops</button>
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold text-ink-900">{stop.seq}. {stop.office ? '🏢 ' : ''}{stop.name}</h1>
      </div>
      {stop.office && (
        <p className="rounded-xl bg-brand-50 px-3 py-2 text-sm text-ink-800 ring-1 ring-brand-100" data-testid="office-stop">
          Office stop: {plural(stop.meal_count, 'tiffin')} for the office members. Hand them to reception or the office contact.
        </p>
      )}

      <Panel>
        <p className="text-base font-medium text-ink-900">{address(stop) || 'No address saved'}</p>
        {stop.delivery_notes ? <p className="text-sm text-amber-800">Note: {stop.delivery_notes}</p> : null}
        <Muted>
          {plural(stop.meal_count, 'meal')}
          {stop.tiffins_with_customer > 0 ? ` · has ${plural(stop.tiffins_with_customer, 'tiffin')} of ours` : ''}
        </Muted>
        <Muted>{stop.phone_masked}</Muted>
        <div className="grid grid-cols-2 gap-2">
          <a href={mapsUrl} target="_blank" rel="noopener noreferrer" data-testid="navigate"
            className="flex min-h-12 items-center justify-center rounded-xl bg-brand-600 px-3 text-base font-semibold text-white active:bg-brand-700">
            🧭 Navigate
          </a>
          <BigButton variant="secondary" onClick={call} disabled={!canAct || run.status !== 'out'}>📞 Call</BigButton>
        </div>
      </Panel>

      {rider.attention.some((a) => a.op.stopId === stop.id) && (
        <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200" data-testid="stop-attention">
          ⚠ A saved action for this stop was not accepted: {friendlyErrorIn('rider', { message: rider.attention.find((a) => a.op.stopId === stop.id)!.reason })}. See the list on the stops page.
        </p>
      )}

      {stop.status !== 'pending' && (
        <Panel>
          <p className={`text-base font-semibold ${stop.status === 'delivered' ? 'text-green-700' : 'text-red-700'}`} data-testid="stop-status">
            {STATUS_LABEL[stop.status]}
            {stop.failed_reason ? ` · ${REASON_LABEL[stop.failed_reason as Reason] ?? stop.failed_reason}` : ''}
          </p>
          {stop.queued && <Muted>Saved on this phone, will sync.</Muted>}
        </Panel>
      )}

      {canAct && !failing && stop.qr_token && <ScanSticker expected={stop.qr_token} value={scanned} onChange={setScanned} />}

      {canAct && !failing && (
        <Panel>
          <Stepper label="Tiffins given" value={out} onChange={setTiffinsOut} testId="tiffins-out" />
          <Stepper label="Empty tiffins taken back" value={back} onChange={setTiffinsBack} testId="tiffins-back" />
          <label className="block space-y-1">
            <span className="text-sm font-medium text-ink-700">Cash collected (₹, optional)</span>
            <FieldInput value={cash} onChange={(e) => setCash(e.target.value)} inputMode="decimal" placeholder="0" data-testid="cash" />
          </label>
          <ErrorText>{error}</ErrorText>
          {/* Photo is the main proof: most Phase 1 customers get no WhatsApp code. */}
          <input ref={photoInput} type="file" accept="image/*" capture="environment" className="hidden" data-testid="photo-input"
            onChange={(e) => void onPhoto(e.target.files?.[0])} />
          <BigButton onClick={() => photoInput.current?.click()} disabled={busy} data-testid="take-photo">
            {busy ? 'Saving…' : '📷 Delivered: take photo'}
          </BigButton>
          {stop.otp_sent && (
            <div className="space-y-2 border-t border-ink-100 pt-3">
              <label className="block space-y-1">
                <span className="text-sm font-medium text-ink-700">Delivery code (optional)</span>
                <span className="block text-sm text-ink-500">If the customer has a 4-digit delivery code on WhatsApp, you can enter it instead of a photo.</span>
                <FieldInput value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 4))} inputMode="numeric"
                  autoComplete="one-time-code" maxLength={4} placeholder="0000" className="text-center text-2xl tracking-[0.5em]" data-testid="otp-input" />
              </label>
              <BigButton variant="secondary" onClick={() => deliver('otp')} disabled={busy || otp.trim().length !== 4} data-testid="confirm-otp">
                Delivered: confirm code
              </BigButton>
            </div>
          )}
          <button type="button" onClick={() => deliver('none')} disabled={busy} className="block w-full py-2 text-center text-sm text-ink-600 underline" data-testid="no-proof">
            Delivered without photo
          </button>
          <button type="button" onClick={() => { setError(''); setFailing(true); }} className="block w-full py-2 text-center text-sm font-medium text-red-700 underline" data-testid="could-not-deliver">
            Could not deliver
          </button>
        </Panel>
      )}

      {canAct && failing && (
        <Panel>
          <p className="text-sm font-medium text-ink-700">Why?</p>
          <div className="flex flex-wrap gap-2">
            {REASONS.map((r) => <Chip key={r} label={REASON_LABEL[r]} selected={reason === r} onClick={() => setReason(r)} testId={`reason-${r}`} />)}
          </div>
          {reason && KITCHEN_FAULT.has(reason) && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">The customer gets the meal back as credit.</p>}
          <label className="block space-y-1">
            <span className="text-sm font-medium text-ink-700">Note{reason === 'other' ? ' (required)' : ''}</span>
            <FieldInput value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} data-testid="fail-note" />
          </label>
          <Stepper label="Empty tiffins taken back" value={back} onChange={setTiffinsBack} />
          <ErrorText>{error}</ErrorText>
          <BigButton variant="danger" onClick={fail} disabled={busy} data-testid="fail-save">{busy ? 'Saving…' : 'Save as not delivered'}</BigButton>
          <BigButton variant="secondary" onClick={() => setFailing(false)}>Back</BigButton>
        </Panel>
      )}
    </div>
  );
}
