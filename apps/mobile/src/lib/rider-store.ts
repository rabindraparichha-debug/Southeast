// Rider mode offline store. Today's runs are cached on the phone; every rider action is queued with
// the time it was tapped and a client id, applied to the cache at once, and sent in order. When the
// network is down the queue waits and syncs later; the server keeps the original timestamps and
// the client id makes a retried action count once (complete_stop / fail_stop in the database).
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import { useSyncExternalStore } from 'react';
import { supabase } from './supabase';

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

type Kind = 'start' | 'complete' | 'fail' | 'finish';
export type QueuedOp = {
  op: string; // client id (idempotency key)
  kind: Kind;
  runId: string;
  stopId?: string;
  at: string; // when the rider tapped (device time)
  offline: boolean; // could not be sent at the time
  args: Record<string, unknown>;
  photoUri?: string;
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

const CACHE_KEY = 'tiffin.rider.runs';
const QUEUE_KEY = 'tiffin.rider.queue';

let state: State = { loaded: false, runs: [], queue: [], fetchedAt: null, online: true, syncing: false, lastError: null };
const listeners = new Set<() => void>();

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

async function persist() {
  await AsyncStorage.multiSet([
    [CACHE_KEY, JSON.stringify({ runs: state.runs, fetchedAt: state.fetchedAt })],
    [QUEUE_KEY, JSON.stringify(state.queue)],
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

/** supabase-js reports a dropped connection as an error without a Postgres code. */
export function isNetworkError(e: { message?: string; code?: string; statusCode?: string } | null | undefined): boolean {
  if (!e) return false;
  if (e.code && e.code !== '') return false;
  return /network|fetch|timed? ?out|abort|connection/i.test(e.message ?? '');
}

let loading: Promise<void> | null = null;
export function loadRider(): Promise<void> {
  loading ??= (async () => {
    const [[, cache], [, queue]] = await AsyncStorage.multiGet([CACHE_KEY, QUEUE_KEY]);
    const c = cache ? (JSON.parse(cache) as { runs: RiderRun[]; fetchedAt: string | null }) : { runs: [], fetchedAt: null };
    set({ loaded: true, runs: c.runs, fetchedAt: c.fetchedAt, queue: queue ? JSON.parse(queue) : [] });
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

type SendResult = { ok: true; data: unknown } | { ok: false; network: boolean; message: string };

async function send(q: QueuedOp): Promise<SendResult> {
  if (q.photoUri && q.photoPath && !q.uploaded) {
    try {
      const bytes = await readBytes(q.photoUri);
      const { error } = await supabase.storage.from('proofs').upload(q.photoPath, bytes, { contentType: 'image/jpeg' });
      // A retry after a lost response finds the photo already there: that is fine.
      if (error && !/exist|duplicate/i.test(error.message)) {
        return { ok: false, network: isNetworkError(error as { message: string }), message: error.message };
      }
    } catch (e) {
      return { ok: false, network: true, message: String((e as Error).message) };
    }
    q.uploaded = true;
  }
  const common = { p_at: q.at };
  const call =
    q.kind === 'start'
      ? supabase.rpc('start_run', { p_run: q.runId, ...common })
      : q.kind === 'finish'
        ? supabase.rpc('finish_run', { p_run: q.runId, ...common })
        : q.kind === 'complete'
          ? supabase.rpc('complete_stop', {
              ...(q.args as { p_proof: 'otp' | 'photo' | 'none' }),
              p_stop: q.stopId!, ...common, p_client_op: q.op, p_offline: q.offline, p_photo_path: q.photoPath,
            })
          : supabase.rpc('fail_stop', {
              ...(q.args as { p_reason: 'not_home' }),
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
        const q = state.queue[0];
        const res = await send(q);
        if (!res.ok && res.network) {
          const queue = state.queue.map((x) => ({ ...x, offline: true }));
          set({ online: false, queue });
          await persist();
          return;
        }
        if (!res.ok) set({ lastError: res.message });
        dropPhoto(q.photoUri);
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
  const { data, error } = await supabase.rpc('rider_today');
  if (error) {
    set({ online: !isNetworkError(error), lastError: isNetworkError(error) ? state.lastError : error.message });
    return;
  }
  set({ runs: overlay((data ?? []) as RiderRun[], state.queue), fetchedAt: new Date().toISOString(), online: true });
  await persist();
}

export type ActResult = { synced: boolean; otpWrong?: boolean; error?: string; data?: unknown };

/**
 * Records a rider action: shown at once, saved on the phone, sent now if possible.
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

/** Forget everything on log-out. */
export async function resetRider() {
  state = { loaded: false, runs: [], queue: [], fetchedAt: null, online: true, syncing: false, lastError: null };
  loading = null;
  await AsyncStorage.multiRemove([CACHE_KEY, QUEUE_KEY]);
  listeners.forEach((l) => l());
}
