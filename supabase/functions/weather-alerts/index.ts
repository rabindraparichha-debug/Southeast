// Rain and heat alerts (P5). Started at 06:00 and 16:00 IST by pg_cron (private.kick_function) with
// the service role. For every kitchen with a location it reads the hourly forecast (Open-Meteo, no
// API key; WEATHER_MODE=mock by default, no network) and records at most one alert per
// kitchen/date/slot through weather_record_alert, which queues the owner alert and, if the kitchen
// opted in, a "delivery may be late" notice to its customers.
import { corsHeaders, json, rpc } from '../_shared/http.ts';
import { loadMonitorConfig, reportError } from '../_shared/monitor.ts';
import { decideAlerts, loadWeatherConfig, mockForecast, openMeteoUrl, targetSlots, type Forecast, type MockScenario } from '../_shared/weather.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const monitor = loadMonitorConfig((k) => Deno.env.get(k));

type KitchenRow = { kitchen_id: string; name: string; lat: number; lng: number };

const call = async <T>(fn: string, args: Record<string, unknown>) => {
  const { data, error } = await rpc<T>(SUPABASE_URL, SERVICE_ROLE_KEY, `Bearer ${SERVICE_ROLE_KEY}`, fn, args);
  if (error) throw new Error(error.message);
  return data as T;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.headers.get('Authorization') !== `Bearer ${SERVICE_ROLE_KEY}`) return json({ error: 'forbidden' }, 403);
  let cfg;
  try {
    cfg = loadWeatherConfig((k) => Deno.env.get(k));
  } catch (e) {
    return json({ error: String((e as Error).message) }, 500);
  }
  // Optional body (ops re-runs and tests): { now, kitchen_id, scenario (mock mode only) }.
  const body = await req.json().catch(() => ({})) as { now?: string; kitchen_id?: string; scenario?: MockScenario };
  const now = body.now ? new Date(body.now) : new Date();
  if (Number.isNaN(now.getTime())) return json({ error: 'invalid_now' }, 400);
  const scenario = cfg.mode === 'mock' && body.scenario && ['none', 'rain', 'heat'].includes(body.scenario) ? body.scenario : cfg.scenario;
  const targets = targetSlots(now);
  const kitchens = (await call<KitchenRow[]>('weather_kitchens', {})).filter((k) => !body.kitchen_id || k.kitchen_id === body.kitchen_id);
  const counts = { kitchens: kitchens.length, alerts: 0, duplicates: 0, errors: 0 };
  for (const k of kitchens) {
    try {
      let forecast: Forecast;
      if (cfg.mode === 'mock') {
        forecast = mockForecast([...new Set(targets.map((t) => t.date))], scenario);
      } else {
        const res = await fetch(openMeteoUrl(cfg.baseUrl, k.lat, k.lng));
        if (!res.ok) throw new Error(`open-meteo ${res.status}`);
        forecast = await res.json() as Forecast;
      }
      for (const d of decideAlerts(forecast, targets)) {
        const r = await call<{ created: boolean }>('weather_record_alert',
          { p_kitchen: k.kitchen_id, p_date: d.date, p_slot: d.slot, p_kind: d.kind, p_detail: d.detail });
        if (r.created) counts.alerts++;
        else counts.duplicates++;
      }
    } catch (e) {
      counts.errors++;
      await reportError(monitor, e, { fn: 'weather-alerts', tags: { kitchen: k.kitchen_id } });
    }
  }
  return json({ mode: cfg.mode, targets, ...counts });
});
