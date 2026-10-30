'use client';

// Rider mode offline store (web port of apps/mobile/src/lib/rider-store.ts; keep the two in step).
// Today's runs are cached in IndexedDB; every rider action is queued with the time it was tapped and
// a client id, applied to the cache at once, and sent in order. When the network is down the queue
// waits and syncs later; the server keeps the original timestamps and the client id makes a retried
// action count once (complete_stop / fail_stop in the database). Proof photos are kept as bytes in
// IndexedDB until they are uploaded.
import { useSyncExternalStore } from 'react';
import type { Database } from '@tiffin/db';
import { supabaseBrowser } from './supabase/client';
import { idbDelete, idbGet, idbKeys, idbSet } from './idb';

export type RiderStop = {
  id: string;
  seq: number;
  customer_id: string;
  name: string;
  phone_masked: string;
  line1: string | null;
  area: string | null;
  landmark: string | null;
  delivery_notes: string | null;
  lat: number | null;
  lng: number | null;
  meal_count: number;
  diets: Record<string, number> | null;
  status: 'pending' | 'delivered' | 'failed';
  proof_type: string | null;
  otp_ok: boolean | null;
  done_at: string | null;
  failed_reason: string | null;
  tiffins_out: number;
  tiffins_returned: number;
  tiffins_with_customer: number;
  otp_sent: boolean;
  queued?: boolean; // changed on this device, not synced yet
};

export type RiderRun = {
  id: string;
  kitchen_id: string;
  kitchen_name: string;
  kitchen_lat: number | null;
  kitchen_lng: number | null;
  route_name: string;
  service_date: string;
  slot: 'lunch' | 'dinner';
  status: 'planned' | 'out' | 'done';
  started_at: string | null;
  finished_at: string | null;
  planned_km: number | null;
  stops: RiderStop[];
};

type Kind = 'start' | 'complete' | 'fail' | 'finish';
export type QueuedOp = {
  op: string; // client id (idempotency key)
  kind: Kind;
  runId: string;
  stopId?: string;
  at: string; // when the rider tapped (device time)
  offline: boolean; // could not be sent at the time
  args: Record<string, unknown>;
  hasPhoto?: boolean; // bytes stored in IndexedDB under photoKey(op)
  photoPath?: string;
  uploaded?: boolean;
};

type State = {
  loaded: boolean;
  runs: RiderRun[];
  queue: QueuedOp[];
  fetchedAt: string | null;
  online: boolean;
  syncing: boolean;
  lastError: string | null;
};

const CACHE_KEY = 'rider.runs';
const QUEUE_KEY = 'rider.queue';
const PHOTO_PREFIX = 'rider.photo:';
const photoKey = (op: string) => `${PHOTO_PREFIX}${op}`;

const initial = (): State => ({
  loaded: false, runs: [], queue: [], fetchedAt: null,
  online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  syncing: false, lastError: null,
});
const SERVER_STATE = initial();
let state: State = initial();
const listeners = new Set<() => void>();

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

async function persist() {
  await idbSet({
    [CACHE_KEY]: { runs: state.runs, fetchedAt: state.fetchedAt, userId: currentUser },
    [QUEUE_KEY]: state.queue,
  });
}

export function useRider(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => state,
    () => SERVER_STATE,
  );
}

/** A random v4 UUID (idempotency key). */
export function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** supabase-js reports a dropped connection as an error without a Postgres code. */
export function isNetworkError(e: { message?: string; code?: string } | null | undefined): boolean {
  if (!e) return false;
  if (e.code && e.code !== '') return false;
  return /network|fetch|load failed|timed? ?out|abort|connection|offline/i.test(e.message ?? '');
}

let currentUser: string | null = null;
let loading: Promise<void> | null = null;

/**
 * Loads the cache and queue from IndexedDB. With a userId, a cache left by someone else on this
 * device is dropped (log-out is blocked while actions are queued, so nothing unsent is lost).
 */
export function loadRider(userId?: string): Promise<void> {
  loading ??= (async () => {
    if (userId) currentUser = userId;
    let cache: { runs: RiderRun[]; fetchedAt: string | null; userId?: string | null } | undefined;
    let queue: QueuedOp[] | undefined;
    try {
      [cache, queue] = await Promise.all([idbGet<typeof cache>(CACHE_KEY), idbGet<QueuedOp[]>(QUEUE_KEY)]);
    } catch {
      // unreadable storage: start empty
    }
    if (userId && cache?.userId && cache.userId !== userId && !(queue?.length)) {
      cache = undefined;
      queue = [];
    }
    if (!currentUser && cache?.userId) currentUser = cache.userId;
    set({ loaded: true, runs: cache?.runs ?? [], fetchedAt: cache?.fetchedAt ?? null, queue: queue ?? [] });
  })();
  return loading;
}

// Apply queued actions on top of server data, so the screen shows what the rider did.
function overlay(runs: RiderRun[], queue: QueuedOp[]): RiderRun[] {
  return runs.map((run) => {
    let r = run;
    for (const q of queue.filter((x) => x.runId === run.id)) {
      if (q.kind === 'start' && r.status === 'planned') r = { ...r, status: 'out', started_at: q.at };
      if (q.kind === 'finish') r = { ...r, status: 'done', finished_at: q.at };
      if ((q.kind === 'complete' || q.kind === 'fail') && q.stopId) {
        if (r.status === 'planned') r = { ...r, status: 'out', started_at: q.at };
        r = {
          ...r,
          stops: r.stops.map((s) =>
            s.id === q.stopId && s.status === 'pending'
              ? {
                  ...s,
                  status: q.kind === 'complete' ? 'delivered' : 'failed',
                  done_at: q.at,
                  proof_type: (q.args.p_proof as string) ?? null,
                  failed_reason: (q.args.p_reason as string) ?? null,
                  tiffins_out: Number(q.args.p_tiffins_out ?? 0),
                  tiffins_returned: Number(q.args.p_tiffins_returned ?? 0),
                  queued: true,
                }
              : s,
          ),
        };
      }
    }
    return r;
  });
}

/** Keeps a proof photo (already downscaled JPEG) on the device until it is uploaded. */
export async function keepPhoto(blob: Blob, op: string): Promise<void> {
  await idbSet({ [photoKey(op)]: await blob.arrayBuffer() });
}

function dropPhoto(op: string) {
  void idbDelete([photoKey(op)]).catch(() => undefined);
}

type SendResult = { ok: true; data: unknown } | { ok: false; network: boolean; message: string };
type CompleteArgs = Database['public']['Functions']['complete_stop']['Args'];
type FailArgs = Database['public']['Functions']['fail_stop']['Args'];

async function send(q: QueuedOp): Promise<SendResult> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { ok: false, network: true, message: 'offline' };
  const supabase = supabaseBrowser();
  if (q.hasPhoto && q.photoPath && !q.uploaded) {
    try {
      const bytes = await idbGet<ArrayBuffer>(photoKey(q.op));
      if (!bytes) return { ok: false, network: false, message: 'invalid_photo' };
      const { error } = await supabase.storage.from('proofs').upload(q.photoPath, bytes, { contentType: 'image/jpeg' });
      // A retry after a lost response finds the photo already there: that is fine.
      if (error && !/exist|duplicate/i.test(error.message)) {
        return { ok: false, network: isNetworkError(error as { message: string }), message: error.message };
      }
    } catch (e) {
      return { ok: false, network: true, message: String((e as Error).message) };
    }
    q.uploaded = true;
    await persist();
  }
  const common = { p_at: q.at };
  const call =
    q.kind === 'start'
      ? supabase.rpc('start_run', { p_run: q.runId, ...common })
      : q.kind === 'finish'
        ? supabase.rpc('finish_run', { p_run: q.runId, ...common })
        : q.kind === 'complete'
          ? supabase.rpc('complete_stop', {
              ...(q.args as Omit<CompleteArgs, 'p_stop'>),
              p_stop: q.stopId!, ...common, p_client_op: q.op, p_offline: q.offline, p_photo_path: q.photoPath,
            })
          : supabase.rpc('fail_stop', {
              ...(q.args as Omit<FailArgs, 'p_stop'>),
              p_stop: q.stopId!, ...common, p_client_op: q.op, p_offline: q.offline,
            });
  try {
    const { data, error } = await call;
    if (error) return { ok: false, network: isNetworkError(error), message: error.message };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, network: true, message: String((e as Error).message) };
  }
}

let syncing: Promise<void> | null = null;
/** Sends queued actions in order. Stops at the first network failure (they wait for the next try). */
export function syncQueue(): Promise<void> {
  syncing ??= (async () => {
    await loadRider();
    set({ syncing: true });
    try {
      while (state.queue.length) {
        const q = state.queue[0]!;
        const res = await send(q);
        if (!res.ok && res.network) {
          const queue = state.queue.map((x) => ({ ...x, offline: true }));
          set({ online: false, queue });
          await persist();
          return;
        }
        if (!res.ok) set({ lastError: res.message });
        if (q.hasPhoto) dropPhoto(q.op);
        set({ online: true, queue: state.queue.slice(1) });
        await persist();
      }
    } finally {
      set({ syncing: false });
      syncing = null;
    }
  })();
  return syncing;
}

/** Sync first, then reload today's runs from the server (keeps the cache when offline). */
export async function refreshRider(): Promise<void> {
  await syncQueue();
  if (state.queue.length) return; // still offline
  const { data, error } = await supabaseBrowser().rpc('rider_today');
  if (error) {
    set({ online: !isNetworkError(error), lastError: isNetworkError(error) ? state.lastError : error.message });
    return;
  }
  set({ runs: overlay((data ?? []) as unknown as RiderRun[], state.queue), fetchedAt: new Date().toISOString(), online: true });
  await persist();
}

export type ActResult = { synced: boolean; otpWrong?: boolean; error?: string; data?: unknown };

/**
 * Records a rider action: shown at once, saved on the device, sent now if possible.
 * A wrong OTP while online is reported back instead of being saved.
 */
export async function act(input: Omit<QueuedOp, 'op' | 'at' | 'offline'> & { op?: string }): Promise<ActResult> {
  await loadRider();
  set({ lastError: null });
  const q: QueuedOp = { ...input, op: input.op ?? uuid(), at: new Date().toISOString(), offline: !state.online };
  const isOtp = q.kind === 'complete' && q.args.p_proof === 'otp';

  // Online OTP: check it directly so the rider can retry a wrong code.
  if (isOtp && state.online && state.queue.length === 0) {
    const res = await send(q);
    if (res.ok) {
      const d = res.data as { status?: string; otp_ok?: boolean };
      if (d?.status === 'pending' && d.otp_ok === false) return { synced: true, otpWrong: true };
      set({ runs: overlay(state.runs, [q]).map((r) => ({ ...r, stops: r.stops.map((s) => (s.id === q.stopId ? { ...s, queued: false, otp_ok: true } : s)) })) });
      await persist();
      return { synced: true, data: res.data };
    }
    if (!res.network) return { synced: false, error: res.message };
    q.offline = true;
    set({ online: false });
  }

  set({ queue: [...state.queue, q], runs: overlay(state.runs, [q]) });
  await persist();
  await syncQueue();
  const stillQueued = state.queue.some((x) => x.op === q.op);
  if (!stillQueued) {
    set({ runs: state.runs.map((r) => ({ ...r, stops: r.stops.map((s) => (s.id === q.stopId ? { ...s, queued: false } : s)) })) });
    await persist();
  }
  return { synced: !stillQueued, error: state.lastError ?? undefined };
}

export function clearRiderError() {
  set({ lastError: null });
}

/** The browser says the connection dropped: show the banner before the next action fails. */
export function markOffline() {
  set({ online: false });
}

/** Forget everything on log-out. */
export async function resetRider() {
  state = initial();
  loading = null;
  currentUser = null;
  try {
    await idbDelete([CACHE_KEY, QUEUE_KEY, ...(await idbKeys(PHOTO_PREFIX))]);
  } catch {
    // best effort
  }
  listeners.forEach((l) => l());
}

/** Number of actions still waiting on this device (for the log-out guard). */
export async function queuedCount(): Promise<number> {
  await loadRider();
  return state.queue.length;
}
