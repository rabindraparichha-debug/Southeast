// Rider mode offline store. Today's runs are cached on the phone; every rider action is queued with
// the time it was tapped and a client id, applied to the cache at once, saved, and sent in order in
// the background. The server keeps the original timestamps and the client id makes a retried action
// count once (complete_stop / fail_stop in the database).
//
// Nothing the rider records is ever dropped:
// - temporary failures (no network, server busy, login to refresh) stay in the queue and are retried
//   with backoff (rider-queue.ts classifyError);
// - only the business refusals the rider RPCs raise (FINAL_ERRORS), plus wrong codes and stops someone
//   else marked first, move to the "needs attention" list, kept with their photo and cash amount until
//   the rider tries again or discards them.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import { AppState, Platform } from 'react-native';
import { useSyncExternalStore } from 'react';
import {
  afterFailure, classifyError, completeStopArgs, isDue, judgeResult, parseAttention, parseQueue, requeue,
  type AttentionItem, type ErrorLike, type QueuedOp,
} from './rider-queue';
import { supabase } from './supabase';

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
  qr_token?: string | null; // tiffin sticker code (P5); missing in caches from older versions
  office?: boolean; // office stop (P6): name is the office, meal_count covers every member
  queued?: boolean; // changed on the phone, not synced yet
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

const CACHE_KEY = 'tiffin.rider.runs';
const QUEUE_KEY = 'tiffin.rider.queue';
const ATTENTION_KEY = 'tiffin.rider.attention';

const initial = (): State => ({
  loaded: false, runs: [], queue: [], attention: [], fetchedAt: null, online: true, syncing: false, lastError: null,
});
let state: State = initial();
const listeners = new Set<() => void>();

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

async function persist() {
  await AsyncStorage.multiSet([
    [CACHE_KEY, JSON.stringify({ runs: state.runs, fetchedAt: state.fetchedAt })],
    [QUEUE_KEY, JSON.stringify(state.queue)],
    [ATTENTION_KEY, JSON.stringify(state.attention)],
  ]);
}

export function useRider(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/** A random v4 UUID (Math.random is fine for idempotency keys). */
export function uuid(): string {
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

let loading: Promise<void> | null = null;
export function loadRider(): Promise<void> {
  loading ??= (async () => {
    let cache: string | null = null;
    let queue: string | null = null;
    let attention: string | null = null;
    try {
      [[, cache], [, queue], [, attention]] = await AsyncStorage.multiGet([CACHE_KEY, QUEUE_KEY, ATTENTION_KEY]);
    } catch {
      // unreadable storage: start empty
    }
    let c: { runs: RiderRun[]; fetchedAt: string | null } = { runs: [], fetchedAt: null };
    try {
      if (cache) c = JSON.parse(cache) as typeof c;
    } catch {
      // damaged cache: the next refresh reloads it
    }
    set({
      loaded: true, runs: Array.isArray(c.runs) ? c.runs : [], fetchedAt: c.fetchedAt ?? null,
      queue: parseQueue(queue), attention: parseAttention(attention),
    });
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

async function readBytes(uri: string): Promise<ArrayBuffer> {
  if (Platform.OS === 'web') return (await fetch(uri)).arrayBuffer();
  return new File(uri).arrayBuffer();
}

function photoMissing(uri: string): boolean {
  if (Platform.OS === 'web') return false;
  try {
    return !new File(uri).exists;
  } catch {
    return false;
  }
}

/** Copies a camera photo somewhere it survives until it is uploaded. */
export async function keepPhoto(uri: string, name: string): Promise<string> {
  if (Platform.OS === 'web') return uri;
  const dir = new Directory(Paths.document, 'proofs');
  dir.create({ idempotent: true, intermediates: true });
  const dest = new File(dir, `${name}.jpg`);
  await new File(uri).copy(dest);
  return dest.uri;
}

function dropPhoto(uri?: string) {
  if (!uri || Platform.OS === 'web') return;
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // best effort
  }
}

type SendResult = { ok: true; data: unknown } | { ok: false; error: ErrorLike };

async function send(q: QueuedOp): Promise<SendResult> {
  // Requests time out in the client (lib/supabase.ts), so a weak signal never stalls the queue.
  if (q.photoUri && q.photoPath && !q.uploaded) {
    if (photoMissing(q.photoUri)) return { ok: false, error: { message: 'invalid_photo' } };
    try {
      const bytes = await readBytes(q.photoUri);
      const { error } = await supabase.storage.from('proofs').upload(q.photoPath, bytes, { contentType: 'image/jpeg' });
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
          ? supabase.rpc('complete_stop', completeStopArgs(q) as { p_stop: string; p_proof: 'otp' | 'photo' | 'none' })
          : q.kind === 'request'
            // A customer's change written down at the door; the queue's client id is its idempotency key.
            ? supabase.rpc('rider_request_change', {
                ...(q.args as { p_type: 'skip' | 'pause' | 'address'; p_from: string }),
                p_stop: q.stopId!, p_client_op: q.op,
              })
            : supabase.rpc('fail_stop', {
              ...(q.args as { p_reason: 'not_home' }),
              p_stop: q.stopId!, ...common, p_client_op: q.op, p_offline: q.offline,
            });
  try {
    const { data, error, status } = await call;
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
  if (!state.queue.length) return;
  const head = state.queue[0];
  const wait = head.nextAt ? Date.parse(head.nextAt) - Date.now() : 0;
  timer = setTimeout(() => {
    timer = null;
    void syncQueue();
  }, Math.min(5 * 60_000, Math.max(1_000, Number.isFinite(wait) ? wait : 0)));
}

let syncing: Promise<void> | null = null;
/**
 * Sends queued actions in order. A temporary failure keeps the action at the head with its backoff
 * (later actions wait behind it); force ignores the backoff (reconnect, app back in front, refresh).
 */
export function syncQueue(opts: { force?: boolean } = {}): Promise<void> {
  syncing ??= (async () => {
    let parked = false;
    try {
      await loadRider();
      if (!state.queue.length) return;
      set({ syncing: true });
      while (state.queue.length) {
        const q = state.queue[0];
        if (!opts.force && !isDue(q, Date.now())) break;
        const res = await send(q);
        if (res.ok) {
          const judged = judgeResult(q, res.data);
          if (!judged.ok) {
            set({ queue: state.queue.slice(1), attention: [...state.attention, parkItem(q, judged.reason)] });
            parked = true;
          } else {
            dropPhoto(q.photoUri);
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
  try {
    const { data, error, status } = await supabase.rpc('rider_today');
    if (error) {
      const v = classifyError({ ...error, status });
      set({ online: !(v.kind === 'wait' && v.network), lastError: v.kind === 'wait' && v.network ? state.lastError : v.reason });
      return;
    }
    set({ runs: overlay((data ?? []) as RiderRun[], state.queue), fetchedAt: new Date().toISOString(), online: true });
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
 * Records a rider action: shown at once and saved on the phone, then sent in the background. Resolves
 * as soon as the action is saved. The one exception is a delivery code typed while online with
 * nothing queued: it is checked right away (bounded by the request timeout) so the rider can fix a
 * wrong code at the door.
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
  dropPhoto(item.op.photoUri);
  set({ attention: state.attention.filter((a) => a !== item) });
  await persist();
}

export function clearRiderError() {
  set({ lastError: null });
}

/** Actions still on this phone: queued or needing attention. Log-out is blocked while there are any. */
export function riderPendingCount(): number {
  return state.queue.length + state.attention.length;
}

/**
 * Keeps the queue moving wherever the app is (not only on the Rider tab): now, when the app comes
 * back to the front, and every minute as a safety net. Returns a stop function.
 */
export function startRiderSync(): () => void {
  void loadRider().then(() => syncQueue({ force: true }));
  const sub = AppState.addEventListener('change', (s) => {
    if (s === 'active') void syncQueue({ force: true });
  });
  const interval = setInterval(() => void syncQueue(), 60_000);
  return () => {
    sub.remove();
    clearInterval(interval);
  };
}

/** Forget everything on log-out (only called with nothing left to send). */
export async function resetRider() {
  if (timer) clearTimeout(timer);
  timer = null;
  for (const a of state.attention) dropPhoto(a.op.photoUri);
  state = initial();
  loading = null;
  await AsyncStorage.multiRemove([CACHE_KEY, QUEUE_KEY, ATTENTION_KEY]);
  listeners.forEach((l) => l());
}
