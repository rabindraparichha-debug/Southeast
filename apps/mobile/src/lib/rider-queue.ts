// Pure helpers for the rider offline queue (no React Native imports, so they are unit-tested from
// Node in tests/integration/rider-queue.test.ts). The store itself lives in rider-store.ts.

type Kind = 'start' | 'complete' | 'fail' | 'finish';

/**
 * One rider action waiting to be sent. Saved as JSON on the phone, so every field added later must
 * be optional: actions queued by an older app version simply don't have it.
 */
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
  /** Tiffin sticker scanned before delivering (P5). Missing = not scanned. */
  scanToken?: string;
};

/**
 * The code inside a sticker QR. Same rule as private.scan_token in the database:
 * "TFN:ABCD…", a URL ending in the code, or the bare code all read as the code.
 */
export function normalizeScanToken(raw: string | null | undefined): string | null {
  const tail = (raw ?? '').replace(/^.*[:/=]/, '');
  const code = tail.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return code || null;
}

/**
 * Compares a scan with the stop's sticker code (cached from rider_today, so it works offline).
 * 'unknown' when the cache has no code (older cache): the server checks it when the action syncs.
 */
export function checkScan(stopToken: string | null | undefined, scanned: string | null | undefined): 'ok' | 'wrong' | 'unknown' | 'empty' {
  const s = normalizeScanToken(scanned);
  if (!s) return 'empty';
  const want = normalizeScanToken(stopToken);
  if (!want) return 'unknown';
  return s === want ? 'ok' : 'wrong';
}

/**
 * Named arguments for complete_stop. p_scan_token is sent only when the action carries a scan, so
 * actions queued before the scan existed are sent exactly as before.
 */
export function completeStopArgs(q: QueuedOp): Record<string, unknown> {
  const token = normalizeScanToken(q.scanToken);
  return {
    ...q.args,
    p_stop: q.stopId,
    p_at: q.at,
    p_client_op: q.op,
    p_offline: q.offline,
    p_photo_path: q.photoPath,
    ...(token ? { p_scan_token: token } : {}),
  };
}

/** Reads the saved queue; anything unreadable is dropped instead of crashing the app. */
export function parseQueue(raw: string | null | undefined): QueuedOp[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  return data.filter(
    (q): q is QueuedOp =>
      !!q && typeof q === 'object' && typeof (q as QueuedOp).op === 'string' && typeof (q as QueuedOp).kind === 'string'
      && typeof (q as QueuedOp).runId === 'string',
  ).map((q) => ({ ...q, args: q.args && typeof q.args === 'object' ? q.args : {} }));
}
