// Route optimisation with VROOM (https://github.com/VROOM-Project/vroom/blob/master/docs/API.md).
// No external imports, so it is unit-testable from Node (tests/integration/route.test.ts).
//
// By default we send VROOM a duration matrix computed here from straight-line distances, so the
// VROOM server needs no road-routing backend (OSRM/ORS). Set VROOM_USE_ROUTING=true when the
// VROOM server has one: it then gets coordinates and computes road durations itself.

export type Point = { lat: number; lng: number };
export type Stop = Point & { id: string };

export const ROAD_FACTOR = 1.3; // same as private.road_factor() in SQL
const AVG_SPEED_KMH = 18; // two-wheeler in city traffic; only the ratio between legs matters

export function haversineKm(a: Point, b: Point): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Planned km for visiting `points` in order from `start` (road factor applied), 2 decimals. */
export function pathKm(start: Point, points: Point[]): number {
  let km = 0;
  let prev = start;
  for (const p of points) {
    km += haversineKm(prev, p);
    prev = p;
  }
  return Math.round(km * ROAD_FACTOR * 100) / 100;
}

export type VroomRequest = {
  vehicles: { id: number; profile: string; start_index?: number; start?: [number, number] }[];
  jobs: { id: number; location_index?: number; location?: [number, number] }[];
  matrices?: Record<string, { durations: number[][] }>;
  options?: { g?: boolean };
};

/**
 * One vehicle starting at the kitchen, one job per stop, open route (no return to the kitchen).
 * Job ids are 1-based indexes into `stops`.
 */
export function buildVroomRequest(start: Point, stops: Stop[], opts: { useRouting?: boolean; profile?: string } = {}): VroomRequest {
  const profile = opts.profile ?? 'car';
  if (opts.useRouting) {
    return {
      vehicles: [{ id: 1, profile, start: [start.lng, start.lat] }],
      jobs: stops.map((s, i) => ({ id: i + 1, location: [s.lng, s.lat] })),
    };
  }
  const nodes: Point[] = [start, ...stops];
  const durations = nodes.map((a) =>
    nodes.map((b) => Math.round(((haversineKm(a, b) * ROAD_FACTOR) / AVG_SPEED_KMH) * 3600)),
  );
  return {
    vehicles: [{ id: 1, profile, start_index: 0 }],
    jobs: stops.map((_, i) => ({ id: i + 1, location_index: i + 1 })),
    matrices: { [profile]: { durations } },
  };
}

type VroomResponse = {
  code: number;
  error?: string;
  unassigned?: { id: number }[];
  routes?: { vehicle: number; steps: { type: string; job?: number; id?: number }[] }[];
};

/** Stop ids in VROOM's visiting order. Throws on an error response or a dropped stop. */
export function parseVroomOrder(res: VroomResponse, stops: Stop[]): string[] {
  if (!res || res.code !== 0) throw new Error(`vroom_error: ${res?.error ?? res?.code}`);
  if (res.unassigned?.length) throw new Error(`vroom_unassigned: ${res.unassigned.length}`);
  const steps = res.routes?.[0]?.steps ?? [];
  const order = steps
    .filter((s) => s.type === 'job')
    .map((s) => stops[(s.job ?? s.id ?? 0) - 1]?.id)
    .filter((id): id is string => Boolean(id));
  if (order.length !== stops.length || new Set(order).size !== stops.length) {
    throw new Error('vroom_incomplete');
  }
  return order;
}

export async function optimizeWithVroom(
  url: string,
  start: Point,
  stops: Stop[],
  opts: { useRouting?: boolean; fetchFn?: typeof fetch; timeoutMs?: number } = {},
): Promise<string[]> {
  if (stops.length < 2) return stops.map((s) => s.id);
  const fetchFn = opts.fetchFn ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15000);
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildVroomRequest(start, stops, opts)),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`vroom_http_${res.status}`);
    return parseVroomOrder((await res.json()) as VroomResponse, stops);
  } finally {
    clearTimeout(timer);
  }
}
