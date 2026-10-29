// Re-optimises a saved delivery route for the signed-in owner/staff.
// With VROOM_URL set: VROOM computes the order and it is saved with save_route_order (planned runs
// follow). Without it, or if VROOM fails: the built-in optimiser (optimize_route RPC). D-067.
import { corsHeaders, json, rpc } from '../_shared/http.ts';
import { loadMonitorConfig, reportError } from '../_shared/monitor.ts';
import { optimizeWithVroom, pathKm, type Stop } from '../_shared/vroom.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const monitor = loadMonitorConfig((k) => Deno.env.get(k));
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const VROOM_URL = Deno.env.get('VROOM_URL') ?? '';
const VROOM_USE_ROUTING = Deno.env.get('VROOM_USE_ROUTING') === 'true';

type RoutePoints = {
  route_id: string;
  kitchen: { lat: number | null; lng: number | null };
  stops: { address_id: string; lat: number | null; lng: number | null }[];
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const auth = req.headers.get('Authorization');
  if (!auth) return json({ error: 'not_authenticated' }, 401);
  const { route_id } = await req.json().catch(() => ({}));
  if (!route_id) return json({ error: 'not_found' }, 400);

  const local = async (fallback_reason?: string) => {
    const { data, error } = await rpc<Record<string, unknown>>(SUPABASE_URL, ANON_KEY, auth, 'optimize_route', { p_route: route_id });
    if (error) return json({ error: error.message }, 400);
    return json({ ...data, engine: 'local', ...(fallback_reason ? { fallback_reason } : {}) });
  };

  if (!VROOM_URL) return local();

  const { data: rp, error } = await rpc<RoutePoints>(SUPABASE_URL, ANON_KEY, auth, 'route_points', { p_route: route_id });
  if (error || !rp) return json({ error: error?.message ?? 'not_found' }, 400);
  const stops: Stop[] = rp.stops
    .filter((s) => s.lat != null && s.lng != null)
    .map((s) => ({ id: s.address_id, lat: s.lat!, lng: s.lng! }));
  if (stops.length < 2) return local();
  const start = rp.kitchen.lat != null && rp.kitchen.lng != null ? { lat: rp.kitchen.lat, lng: rp.kitchen.lng! } : stops[0];

  try {
    const order = await optimizeWithVroom(VROOM_URL, start, stops, { useRouting: VROOM_USE_ROUTING });
    const byId = new Map(stops.map((s) => [s.id, s]));
    const saved = await rpc(SUPABASE_URL, ANON_KEY, auth, 'save_route_order',
      { p_route: route_id, p_address_ids: order, p_pinned: false });
    if (saved.error) return json({ error: saved.error.message }, 400);
    return json({ engine: 'vroom', km_before: pathKm(start, stops), km_after: pathKm(start, order.map((id) => byId.get(id)!)) });
  } catch (e) {
    console.error('vroom failed, using the built-in optimiser', e);
    await reportError(monitor, e, { fn: 'route-optimize', tags: { engine: 'vroom' } });
    return local(String((e as Error).message).split(':')[0]);
  }
});
