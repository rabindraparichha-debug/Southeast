'use client';

// Rider mode offline store (web port of apps/mobile/src/lib/rider-store.ts; keep the two in step).
// Today's runs are cached in IndexedDB; every rider action is queued with the time it was tapped and
// a client id, applied to the cache at once, saved, and sent in order in the background. The server
// keeps the original timestamps and the client id makes a retried action count once (complete_stop /
// fail_stop in the database). Proof photos are kept as bytes in IndexedDB until they are uploaded.
//
// Nothing the rider records is ever dropped: temporary failures stay queued and are retried with
// backoff; only the business refusals the rider RPCs raise (plus wrong codes and stops someone else
// marked first) move to the "needs attention" list, kept with photo and cash until the rider tries
// again or discards them. The rules are in rider-queue.ts (pure, unit-tested).
import { useSyncExternalStore } from 'react';
import type { Database } from '@tiffin/db';
import { supabaseBrowser } from './supabase/client';
import { idbDelete, idbGet, idbKeys, idbSet } from './idb';
import {
  afterFailure, classifyError, isDue, judgeResult, requeue, sanitizeAttention, sanitizeQueue, withTimeout,
  type AttentionItem, type ErrorLike, type QueuedOp,
} from './rider-queue';

export type { AttentionItem, QueuedOp } from './rider-queue';

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
  /** P5: the code printed as a QR on the stop's sticker (checked again on the server). */
  qr_token?: string | null;
  /** P6: an office stop (name is the office's name). */
  office?: boolean;
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

type State = {
  loaded: boolean;
  runs: RiderRun[];
  queue: QueuedOp[];
  /** Actions the server refused, kept until the rider retries or discards them. */
  attention: AttentionItem[];
  fetchedAt: string | null;
  online: boolean;
  syncing: boolean;
  /** Why the queue is not moving (it is retried), or why the day list could not be loaded. */
  lastError: string | null;
};

const CACHE_KEY = 'rider.runs';
const QUEUE_KEY = 'rider.queue';
const ATTENTION_KEY = 'rider.attention';
const PHOTO_PREFIX = 'rider.photo:';
const photoKey = (op: string) => `${PHOTO_PREFIX}${op}`;
const RPC_TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 120_000;

const initial = (): State => ({
  loaded: false, runs: [], queue: [], attention: [], fetchedAt: null,
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
    [ATTENTION_KEY]: state.attention,
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

/** True when the request never reached the server (no network or timed out). */
export function isNetworkError(e: ErrorLike | null | undefined): boolean {
  if (!e) return false;
  const v = classifyError(e);
  return v.kind === 'wait' && v.network;
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
    let queue: QueuedOp[] = [];
    let attention: AttentionItem[] = [];
    try {
      const [c, q, a] = await Promise.all([idbGet<typeof cache>(CACHE_KEY), idbGet<unknown>(QUEUE_KEY), idbGet<unknown>(ATTENTION_KEY)]);
      cache = c;
      queue = sanitizeQueue(q);
      attention = sanitizeAttention(a);
    } catch {
      // unreadable storage: start empty
    }
    if (userId && cache?.userId && cache.userId !== userId && !queue.length && !attention.length) cache = undefined;
    if (!currentUser && cache?.userId) currentUser = cache.userId;
    set({ loaded: true, runs: Array.isArray(cache?.runs) ? cache.runs : [], fetchedAt: cache?.fetchedAt ?? null, queue, attention });
    schedule();
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

type SendResult = { ok: true; data: unknown } | { ok: false; error: ErrorLike };
type CompleteArgs = Database['public']['Functions']['complete_stop']['Args'];
type FailArgs = Database['public']['Functions']['fail_stop']['Args'];

async function send(q: QueuedOp): Promise<SendResult> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { ok: false, error: { message: 'offline', status: 0 } };
  const supabase = supabaseBrowser();
  if (q.hasPhoto && q.photoPath && !q.uploaded) {
    try {
      const bytes = await idbGet<ArrayBuffer>(photoKey(q.op));
      if (!bytes) return { ok: false, error: { message: 'invalid_photo' } };
      const { error } = await withTimeout(
        supabase.storage.from('proofs').upload(q.photoPath, bytes, { contentType: 'image/jpeg' }), UPLOAD_TIMEOUT_MS);
      // A retry after a lost response finds the photo already there: that is fine.
      if (error && !/exist|duplicate/i.test(error.message)) {
        const e = error as { message: string; status?: number; statusCode?: string; name?: string };
        return { ok: false, error: { message: e.message, status: e.status, statusCode: e.statusCode, name: e.name } };
      }
    } catch (e) {
      return { ok: false, error: { message: String((e as Error).message), name: (e as Error).name } };
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
              ...(q.scanToken ? { p_scan_token: q.scanToken } : {}),
            })
          : supabase.rpc('fail_stop', {
              ...(q.args as Omit<FailArgs, 'p_stop'>),
              p_stop: q.stopId!, ...common, p_client_op: q.op, p_offline: q.offline,
            });
  try {
    type Answer = { data: unknown; error: { message: string; code?: string; details?: string; hint?: string } | null; status: number };
    const { data, error, status } = await withTimeout(call as PromiseLike<Answer>, RPC_TIMEOUT_MS);
    if (error) return { ok: false, error: { ...error, status } };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: { message: String((e as Error).message), name: (e as Error).name } };
  }
}

/** Moves an action to "needs attention" (photo and cash kept). */
function parkItem(q: QueuedOp, reason: string): AttentionItem {
  const { tries: _t, nextAt: _n, lastError: _e, ...op } = q;
  void _t; void _n; void _e;
  return { op, reason, at: new Date().toISOString() };
}

function clearQueuedFlag(stopId?: string) {
  if (!stopId || state.queue.some((x) => x.stopId === stopId)) return;
  set({ runs: state.runs.map((r) => ({ ...r, stops: r.stops.map((s) => (s.id === stopId ? { ...s, queued: false } : s)) })) });
}

let timer: ReturnType<typeof setTimeout> | null = null;
/** Wakes the queue when the first action's backoff is over. */
function schedule() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!state.queue.length || typeof window === 'undefined') return;
  const head = state.queue[0]!;
  const wait = head.nextAt ? Date.parse(head.nextAt) - Date.now() : 0;
  timer = setTimeout(() => {
    timer = null;
    void syncQueue();
  }, Math.min(5 * 60_000, Math.max(1_000, Number.isFinite(wait) ? wait : 0)));
}

let syncing: Promise<void> | null = null;
/**
 * Sends queued actions in order. A temporary failure keeps the action at the head with its backoff
 * (later actions wait behind it); force ignores the backoff (reconnect, back in front, refresh).
 */
export function syncQueue(opts: { force?: boolean } = {}): Promise<void> {
  syncing ??= (async () => {
    let parked = false;
    try {
      await loadRider();
      if (!state.queue.length) return;
      set({ syncing: true });
      while (state.queue.length) {
        const q = state.queue[0]!;
        if (!opts.force && !isDue(q, Date.now())) break;
        const res = await send(q);
        if (res.ok) {
          const judged = judgeResult(q, res.data);
          if (!judged.ok) {
            set({ queue: state.queue.slice(1), attention: [...state.attention, parkItem(q, judged.reason)] });
            parked = true;
          } else {
            if (q.hasPhoto) dropPhoto(q.op);
            set({ online: true, lastError: null, queue: state.queue.slice(1) });
            clearQueuedFlag(q.stopId);
          }
          await persist();
          continue;
        }
        const verdict = classifyError(res.error);
        const next = afterFailure(q, verdict, Date.now());
        if (next.park) {
          set({ queue: state.queue.slice(1), attention: [...state.attention, parkItem(q, next.reason)] });
          parked = true;
          await persist();
          continue;
        }
        const network = verdict.kind === 'wait' && verdict.network;
        // Offline actions are recorded as such (an offline wrong code is kept for the owner to review).
        const rest = state.queue.slice(1).map((x) => (network ? { ...x, offline: true } : x));
        set({
          online: !network,
          lastError: network ? null : next.op.lastError ?? null,
          queue: [network ? { ...next.op, offline: true } : next.op, ...rest],
        });
        await persist();
        break;
      }
    } catch {
      // storage or unexpected failure: the queue in memory is kept and saved with the next change
    } finally {
      set({ syncing: false });
      syncing = null;
      schedule();
    }
    // Refused actions were shown as done: reload the day so the screen shows the server's state.
    if (parked) await reloadRuns();
  })();
  return syncing;
}

async function reloadRuns(): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    set({ online: false });
    return;
  }
  try {
    const { data, error, status } = await withTimeout(supabaseBrowser().rpc('rider_today'), RPC_TIMEOUT_MS);
    if (error) {
      const v = classifyError({ ...error, status });
      set({ online: !(v.kind === 'wait' && v.network), lastError: v.kind === 'wait' && v.network ? state.lastError : v.reason });
      return;
    }
    set({ runs: overlay((data ?? []) as unknown as RiderRun[], state.queue), fetchedAt: new Date().toISOString(), online: true });
    await persist();
  } catch {
    set({ online: false });
  }
}

/** Sync first, then reload today's runs from the server (keeps the cache when offline). */
export async function refreshRider(): Promise<void> {
  await syncQueue({ force: true });
  await reloadRuns();
}

export type ActResult = { synced: boolean; otpWrong?: boolean; error?: string; data?: unknown };

/**
 * Records a rider action: shown at once and saved on the device, then sent in the background.
 * Resolves as soon as the action is saved. The one exception is a delivery code typed while online
 * with nothing queued: it is checked right away (bounded by the request timeout) so the rider can fix
 * a wrong code at the door.
 */
export async function act(input: Omit<QueuedOp, 'op' | 'at' | 'offline'> & { op?: string }): Promise<ActResult> {
  await loadRider();
  const q: QueuedOp = { ...input, op: input.op ?? uuid(), at: new Date().toISOString(), offline: !state.online };
  const isOtp = q.kind === 'complete' && q.args.p_proof === 'otp';

  if (isOtp && state.online && state.queue.length === 0) {
    const res = await send(q);
    if (res.ok) {
      const d = res.data as { status?: string; otp_ok?: boolean };
      if (d?.status === 'pending' && d.otp_ok === false) return { synced: true, otpWrong: true };
      const judged = judgeResult(q, res.data);
      if (!judged.ok) {
        set({ attention: [...state.attention, parkItem(q, judged.reason)] });
        await persist();
        await reloadRuns();
        return { synced: true, data: res.data };
      }
      set({ online: true, runs: overlay(state.runs, [q]).map((r) => ({ ...r, stops: r.stops.map((s) => (s.id === q.stopId ? { ...s, queued: false, otp_ok: true } : s)) })) });
      await persist();
      return { synced: true, data: res.data };
    }
    const verdict = classifyError(res.error);
    // e.g. otp_locked or wrong_tiffin: nothing was saved, the rider fixes it on the stop screen.
    if (verdict.kind === 'final') return { synced: false, error: verdict.reason };
    if (verdict.kind === 'wait' && verdict.network) {
      q.offline = true;
      set({ online: false });
    }
  }

  set({ queue: [...state.queue, q], runs: overlay(state.runs, [q]) });
  await persist();
  void syncQueue({ force: true });
  return { synced: false };
}

/** Puts a refused action back in the queue (same client id, so it can never count twice). */
export async function retryAttention(op?: string): Promise<void> {
  await loadRider();
  const items = state.attention.filter((a) => op === undefined || a.op.op === op);
  if (!items.length) return;
  const back = items.map(requeue);
  set({
    attention: state.attention.filter((a) => !items.includes(a)),
    queue: [...state.queue, ...back],
    runs: overlay(state.runs, back),
  });
  await persist();
  void syncQueue({ force: true });
}

/** Forgets a refused action and its photo (the screen asks the rider to confirm first). */
export async function discardAttention(op: string): Promise<void> {
  await loadRider();
  const item = state.attention.find((a) => a.op.op === op);
  if (!item) return;
  if (item.op.hasPhoto) dropPhoto(item.op.op);
  set({ attention: state.attention.filter((a) => a !== item) });
  await persist();
}

export function clearRiderError() {
  set({ lastError: null });
}

/** The browser says the connection dropped: show the banner before the next action fails. */
export function markOffline() {
  set({ online: false });
}

/**
 * Keeps the queue moving on any page of the web app (not only rider mode): now, when the network
 * comes back, when the app returns to the front, and every minute as a safety net.
 */
export function startRiderSync(userId: string): () => void {
  void loadRider(userId).then(() => syncQueue({ force: true }));
  const onOnline = () => void syncQueue({ force: true });
  const onVisible = () => {
    if (document.visibilityState === 'visible') void syncQueue({ force: true });
  };
  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisible);
  const interval = setInterval(() => void syncQueue(), 60_000);
  return () => {
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisible);
    clearInterval(interval);
  };
}

/** Forget everything on log-out (only called with nothing left to send). */
export async function resetRider() {
  if (timer) clearTimeout(timer);
  timer = null;
  state = initial();
  loading = null;
  currentUser = null;
  try {
    await idbDelete([CACHE_KEY, QUEUE_KEY, ATTENTION_KEY, ...(await idbKeys(PHOTO_PREFIX))]);
  } catch {
    // best effort
  }
  listeners.forEach((l) => l());
}

/** Actions still on this device, queued or needing attention (log-out is blocked while there are any). */
export async function queuedCount(): Promise<number> {
  await loadRider();
  return state.queue.length + state.attention.length;
}
