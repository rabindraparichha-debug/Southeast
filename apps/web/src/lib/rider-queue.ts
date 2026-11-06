// Pure rules for the web rider offline queue (no browser or React imports, so they are unit-tested
// from Node in tests/integration/rider-queue.test.ts). The store lives in rider-store.ts. This is the
// web twin of apps/mobile/src/lib/rider-queue.ts: keep the two in step (the test runs the same cases
// against both).

type Kind = 'start' | 'complete' | 'fail' | 'finish';

/**
 * One rider action waiting to be sent. Saved in IndexedDB, so every field added later must be
 * optional: actions queued by an older version simply don't have it.
 */
export type QueuedOp = {
  op: string; // client id (idempotency key)
  kind: Kind;
  runId: string;
  stopId?: string;
  at: string; // when the rider tapped (device time)
  offline: boolean; // could not be sent at the time
  args: Record<string, unknown>;
  hasPhoto?: boolean; // bytes stored in IndexedDB under the op's photo key
  photoPath?: string;
  uploaded?: boolean;
  /** P5: the sticker the rider scanned before handing over (optional; items queued before P5 have none). */
  scanToken?: string;
  /** Failed send attempts so far. Missing (older versions) = none. */
  tries?: number;
  /** Do not send again before this time (ISO), after a failed attempt. */
  nextAt?: string;
  /** Why the last attempt failed (error code or message), for the screen. */
  lastError?: string;
};

/**
 * An action the server refused, kept on the device with its photo and cash amount until the rider
 * tries it again or discards it (never dropped silently).
 */
export type AttentionItem = {
  op: QueuedOp;
  reason: string; // error code, 'otp_wrong' or 'already_done'
  at: string; // when it was refused (device time)
};

/** The saved queue as read from IndexedDB; anything unreadable is dropped instead of crashing. */
export function sanitizeQueue(data: unknown): QueuedOp[] {
  if (!Array.isArray(data)) return [];
  return data.filter(
    (q): q is QueuedOp =>
      !!q && typeof q === 'object' && typeof (q as QueuedOp).op === 'string' && typeof (q as QueuedOp).kind === 'string'
      && typeof (q as QueuedOp).runId === 'string',
  ).map((q) => ({ ...q, args: q.args && typeof q.args === 'object' ? q.args : {} }));
}

/** The saved "needs attention" list as read from IndexedDB. */
export function sanitizeAttention(data: unknown): AttentionItem[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((x) => {
    if (!x || typeof x !== 'object') return [];
    const item = x as Partial<AttentionItem>;
    const [op] = sanitizeQueue([item.op]);
    if (!op) return [];
    return [{ op, reason: typeof item.reason === 'string' ? item.reason : 'unknown', at: typeof item.at === 'string' ? item.at : op.at }];
  });
}

// ---------------------------------------------------------------------------
// Sending: which failures are final, which are retried
// ---------------------------------------------------------------------------

/**
 * Error codes the rider RPCs (start_run, complete_stop, fail_stop, finish_run, and the
 * require_run_access check they share) raise for a request that will never succeed as it is. Only
 * these are final: the action moves to the "needs attention" list. Everything else is retried.
 */
export const FINAL_ERRORS: readonly string[] = [
  'not_found', // the stop or run no longer exists (planned runs are rebuilt)
  'forbidden', // not this rider's run any more, or a run older than yesterday
  'wrong_tiffin', 'invalid_client_op', 'proof_required', 'photo_required', 'invalid_photo', 'invalid_amount',
  'otp_locked', 'reason_required', 'note_required', 'stops_pending',
];
const FINAL = new Set(FINAL_ERRORS);

/** What supabase-js gives back on a failure (PostgrestError + HTTP status, StorageError, or a thrown Error). */
export type ErrorLike = {
  message?: string | null;
  code?: string | null;
  status?: number | null;
  statusCode?: string | number | null;
  name?: string | null;
};

/**
 * final: a business refusal, needs the rider (moved to "needs attention" at once).
 * wait: temporary (no network, server busy or restarting, login to refresh): retried with backoff
 *   for as long as it takes.
 * retry: unexpected (e.g. 413 photo too large): retried with backoff, then parked in "needs
 *   attention" after MAX_TRIES so it cannot block the actions queued behind it.
 */
export type Verdict =
  | { kind: 'final'; reason: string }
  | { kind: 'wait'; reason: string; network: boolean }
  | { kind: 'retry'; reason: string };

const NETWORK_TEXT = /network|fetch|load failed|timed? ?out|timeout|abort|connection|offline|socket|internet/i;
// Postgres / PostgREST codes for a server that is busy, restarting or shedding load.
const BUSY_CODES = new Set([
  '57014', // statement timeout
  '57P01', '57P02', '57P03', // shutting down / cannot connect now
  '53000', '53100', '53200', '53300', '53400', // out of resources, too many connections
  '40001', '40P01', '55P03', // serialization failure, deadlock, lock not available
  '08000', '08003', '08006', '08001', '08004', // connection problems
  'PGRST000', 'PGRST001', 'PGRST002', 'PGRST003', // PostgREST cannot reach the database / schema cache
]);
const AUTH_CODES = new Set(['PGRST301', 'PGRST302', 'PGRST303', '28000', '28P01']);

export function classifyError(e: ErrorLike | null | undefined): Verdict {
  const message = String(e?.message ?? '').trim();
  const code = String(e?.code ?? '').trim();
  const rawStatus = e?.status ?? e?.statusCode;
  const status = rawStatus === null || rawStatus === undefined || rawStatus === '' ? NaN : Number(rawStatus);
  const reason = message || code || (Number.isFinite(status) ? `http_${status}` : 'unknown');

  if (FINAL.has(message)) return { kind: 'final', reason: message };
  // The login needs refreshing (expired token, or the request went out without one): fixed by the
  // automatic token refresh once the network is back, never by dropping the action.
  if (AUTH_CODES.has(code) || message === 'not_authenticated' || /jwt/i.test(message) || status === 401
      || (code === '42501' && message !== 'forbidden')) {
    return { kind: 'wait', reason: 'not_authenticated', network: false };
  }
  if (BUSY_CODES.has(code)) return { kind: 'wait', reason, network: false };
  // No answer from the server at all (status 0 or a thrown fetch error / timeout).
  if ((!Number.isFinite(status) || status === 0)
      && (NETWORK_TEXT.test(message) || /^(AbortError|TimeoutError)$/.test(String(e?.name ?? '')))) {
    return { kind: 'wait', reason: 'network', network: true };
  }
  if (status >= 500 || status === 408 || status === 429) return { kind: 'wait', reason, network: false };
  return { kind: 'retry', reason };
}

/** Unexpected errors are tried this many times (about 13 minutes with the backoff below), then parked. */
export const MAX_TRIES = 10;

/** Wait before the next attempt: 2 s, 4 s, 8 s … up to 5 minutes. */
export function backoffMs(tries: number): number {
  return Math.min(5 * 60_000, 2_000 * 2 ** Math.max(0, Math.min(tries, 20) - 1));
}

/** True when the action may be sent now (no backoff pending). */
export function isDue(q: QueuedOp, now: number): boolean {
  if (!q.nextAt) return true;
  const t = Date.parse(q.nextAt);
  return !Number.isFinite(t) || t <= now;
}

/** After a failed attempt: keep the action in the queue with its backoff, or park it. */
export function afterFailure(q: QueuedOp, v: Verdict, now: number):
  { park: true; reason: string } | { park: false; op: QueuedOp } {
  if (v.kind === 'final') return { park: true, reason: v.reason };
  const tries = (q.tries ?? 0) + 1;
  if (v.kind === 'retry' && tries >= MAX_TRIES) return { park: true, reason: v.reason };
  return {
    park: false,
    op: { ...q, tries, nextAt: new Date(now + backoffMs(tries)).toISOString(), lastError: v.reason },
  };
}

/** Cash collected at the door with this action, in paise. */
export function cashOf(q: QueuedOp): number {
  const n = Number(q.args?.p_cash_paise ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Checks a successful complete_stop / fail_stop answer. Two answers look like success but would lose
 * the rider's record:
 * - otp_wrong: a delivery code checked online was wrong, so the stop is still pending;
 * - already_done: someone else marked the stop first, and this action carried cash or a different
 *   outcome (the server does not record it).
 */
export function judgeResult(q: QueuedOp, data: unknown): { ok: true } | { ok: false; reason: string } {
  if (q.kind !== 'complete' && q.kind !== 'fail') return { ok: true };
  if (!data || typeof data !== 'object') return { ok: true };
  const d = data as { status?: string; otp_ok?: boolean | null; conflict?: boolean };
  if (q.kind === 'complete' && d.status === 'pending' && d.otp_ok === false) return { ok: false, reason: 'otp_wrong' };
  if (d.conflict === true) {
    const wanted = q.kind === 'complete' ? 'delivered' : 'failed';
    if (d.status !== wanted || cashOf(q) > 0) return { ok: false, reason: 'already_done' };
  }
  return { ok: true };
}

/** A parked action, ready for the queue again (fresh retry count). */
export function requeue(item: AttentionItem): QueuedOp {
  const { tries: _t, nextAt: _n, lastError: _e, ...op } = item.op;
  void _t; void _n; void _e;
  return op;
}

/** Rejects with a timeout error if the promise does not settle in time (the request may still finish). */
export function withTimeout<T>(p: PromiseLike<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), ms);
    Promise.resolve(p).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e: unknown) => { clearTimeout(timer); reject(e); },
    );
  });
}
