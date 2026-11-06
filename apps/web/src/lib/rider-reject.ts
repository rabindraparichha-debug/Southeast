// Pure helpers for telling the owner about rider actions the server refused (report_sync_reject,
// table rider_sync_rejects, docs/DECISIONS.md D-128). No React Native imports: unit-tested from Node
// in tests/integration/rider-reject.test.ts, which runs the same cases against the web twin
// apps/web/src/lib/rider-reject.ts (keep the two identical).
//
// The report is best effort and separate from the queue: it never changes, blocks or drops a queued
// action or a "needs attention" item (those rules stay in rider-queue.ts). What goes out is a short
// summary: never the photo or its path, never the delivery code typed, never a phone number.
import { cashOf, classifyError, type AttentionItem, type ErrorLike } from './rider-queue';

/** The cached run the action belonged to (from rider_today), if the phone still has it. */
export type RunInfo = {
  id: string;
  kitchen_id: string;
  route_name: string;
  service_date: string;
  slot: string;
  stops: readonly { id: string; name: string }[];
};

/** Named arguments for public.report_sync_reject. */
export type RejectReport = {
  p_client_op: string;
  p_kind: string;
  p_error: string;
  /** Omitted when unknown (the server then uses the run's kitchen, or the rider's only kitchen). */
  p_kitchen?: string;
  p_run?: string;
  p_stop?: string;
  p_summary: {
    proof?: string;
    reason?: string;
    note?: string;
    tiffins_out?: number;
    tiffins_returned?: number;
    gps?: boolean;
    offline?: boolean;
    scanned?: boolean;
    stop_label?: string;
    route_label?: string;
    service_date?: string;
    slot?: string;
  };
  p_cash_paise: number;
  p_had_photo: boolean;
  p_acted_at: string;
  p_refused_at: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Photo paths start with the kitchen id ("<kitchen>/<date>/<stop>-<op>.jpg"). */
function kitchenFromPath(path: string | undefined): string | undefined {
  const first = (path ?? '').split('/')[0];
  return isUuid(first) ? first : undefined;
}

/**
 * The report for one parked action, or null when it cannot be sent (an action saved by a very old
 * version without a proper client id). The kitchen comes from the cached run (the server prefers
 * the run's own kitchen when the run still exists).
 */
export function rejectReport(item: AttentionItem, runs: readonly RunInfo[]): RejectReport | null {
  const q = item.op;
  if (!isUuid(q.op)) return null;
  const run = runs.find((r) => r.id === q.runId);
  const stop = run?.stops.find((s) => s.id === q.stopId);
  const a = q.args ?? {};
  const lat = a.p_lat;
  const lng = a.p_lng;
  return {
    p_client_op: q.op,
    p_kind: q.kind,
    p_error: text(item.reason, 120) ?? 'unknown',
    p_kitchen: run?.kitchen_id ?? kitchenFromPath(q.photoPath),
    p_run: isUuid(q.runId) ? q.runId : undefined,
    p_stop: isUuid(q.stopId) ? q.stopId : undefined,
    p_summary: {
      proof: text(a.p_proof, 10),
      reason: text(a.p_reason, 30),
      note: text(a.p_note, 200),
      tiffins_out: count(a.p_tiffins_out),
      tiffins_returned: count(a.p_tiffins_returned),
      gps: q.kind === 'complete' || q.kind === 'fail' ? lat != null && lng != null : undefined,
      offline: q.offline === true,
      scanned: q.kind === 'complete' ? Boolean(q.scanToken) : undefined,
      stop_label: text(stop?.name, 80),
      route_label: text(run?.route_name, 60),
      service_date: run?.service_date,
      slot: run?.slot,
    },
    p_cash_paise: cashOf(q),
    p_had_photo: Boolean(q.photoPath),
    p_acted_at: q.at,
    p_refused_at: item.at,
  };
}

/** Keep a report for later only when the server could not be reached or was busy; drop it otherwise. */
export function keepReport(error: ErrorLike): boolean {
  return classifyError(error).kind === 'wait';
}

/** At most this many reports wait on the phone (oldest dropped first), none older than a week. */
export const MAX_PENDING_REPORTS = 50;
const WEEK_MS = 7 * 24 * 3_600_000;

/** One report per action and refusal, newest last, capped. Keeps the objects themselves. */
export function trimReports(list: readonly RejectReport[], now: number): RejectReport[] {
  const seen = new Set<string>();
  const out: RejectReport[] = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i];
    if (!r) continue;
    const key = `${r.p_client_op}|${r.p_refused_at}`;
    const at = Date.parse(r.p_refused_at);
    if (seen.has(key) || (Number.isFinite(at) && now - at > WEEK_MS)) continue;
    seen.add(key);
    out.unshift(r);
    if (out.length >= MAX_PENDING_REPORTS) break;
  }
  return out;
}

/** Reads saved reports; anything unreadable is dropped. */
export function sanitizeReports(data: unknown): RejectReport[] {
  if (!Array.isArray(data)) return [];
  return data.filter((r): r is RejectReport =>
    !!r && typeof r === 'object' && isUuid((r as RejectReport).p_client_op) && typeof (r as RejectReport).p_kind === 'string'
    && typeof (r as RejectReport).p_refused_at === 'string');
}
