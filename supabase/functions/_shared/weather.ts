// Rain and heat alerts (P5). Pure logic, no external imports: reads an Open-Meteo hourly forecast
// (free, no API key) for a kitchen and decides, per slot delivery window, whether heavy rain or
// heat is expected. The weather-alerts Edge Function fetches the forecast (WEATHER_MODE=live) or
// uses mockForecast (default, no network) and records alerts through weather_record_alert.

export type Slot = 'lunch' | 'dinner';
export type WeatherMode = 'mock' | 'live';
export type MockScenario = 'none' | 'rain' | 'heat';

/** Open-Meteo `hourly` block (times are local, timezone=Asia/Kolkata: "2026-11-02T12:00"). */
export type Hourly = {
  time: string[];
  precipitation?: (number | null)[];
  precipitation_probability?: (number | null)[];
  temperature_2m?: (number | null)[];
  apparent_temperature?: (number | null)[];
  weather_code?: (number | null)[];
};
export type Forecast = { hourly: Hourly };

/** Delivery windows in IST (HH:MM). Hours that start inside [start, end) are checked. */
export type SlotWindow = { slot: Slot; start: string; end: string };
export const DEFAULT_WINDOWS: SlotWindow[] = [
  { slot: 'lunch', start: '11:00', end: '14:00' },
  { slot: 'dinner', start: '19:00', end: '22:00' },
];

/**
 * Heavy rain: ≥ 7.5 mm in an hour (IMD "heavy" intensity), or a thunderstorm / heavy-shower code
 * with ≥ 60 % probability. Heat: air ≥ 40 °C (IMD heat-wave level for the plains) or feels-like ≥ 45 °C.
 */
export const THRESHOLDS = {
  rainMmPerHour: 7.5,
  stormProbabilityPct: 60,
  stormCodes: [65, 67, 81, 82, 95, 96, 99],
  heatTempC: 40,
  heatFeelsC: 45,
};
export type Thresholds = typeof THRESHOLDS;

export type Decision = {
  date: string;
  slot: Slot;
  kind: 'rain' | 'heat' | 'rain_heat';
  detail: { max_rain_mm: number | null; max_probability: number | null; max_temp_c: number | null; max_feels_c: number | null; hours: string[] };
};

export type WeatherConfig = { mode: WeatherMode; scenario: MockScenario; baseUrl: string };

export function loadWeatherConfig(env: (name: string) => string | undefined): WeatherConfig {
  const mode = (env('WEATHER_MODE') || 'mock') as WeatherMode;
  if (mode !== 'mock' && mode !== 'live') throw new Error(`Unknown WEATHER_MODE "${mode}"`);
  const scenario = (env('WEATHER_MOCK_SCENARIO') || 'none') as MockScenario;
  if (!['none', 'rain', 'heat'].includes(scenario)) throw new Error(`Unknown WEATHER_MOCK_SCENARIO "${scenario}"`);
  return { mode, scenario, baseUrl: (env('OPEN_METEO_URL') || 'https://api.open-meteo.com/v1/forecast').replace(/\/$/, '') };
}

export function openMeteoUrl(baseUrl: string, lat: number, lng: number, days = 2): string {
  const q = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lng.toFixed(4),
    hourly: 'precipitation,precipitation_probability,temperature_2m,apparent_temperature,weather_code',
    timezone: 'Asia/Kolkata',
    forecast_days: String(days),
  });
  return `${baseUrl}?${q.toString()}`;
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** IST calendar date and minutes since midnight for an instant. */
export function istParts(now: Date): { date: string; minute: number } {
  const ist = new Date(now.getTime() + 330 * 60_000);
  return { date: ist.toISOString().slice(0, 10), minute: ist.getUTCHours() * 60 + ist.getUTCMinutes() };
}

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The (date, slot) pairs worth checking now: windows that have not ended, within the next 30 hours. */
export function targetSlots(now: Date, windows: SlotWindow[] = DEFAULT_WINDOWS): { date: string; slot: Slot }[] {
  const { date, minute } = istParts(now);
  const out: { date: string; slot: Slot }[] = [];
  for (const offset of [0, 1]) {
    for (const w of windows) {
      const startIn = offset * 1440 + minutes(w.start) - minute;
      const endIn = offset * 1440 + minutes(w.end) - minute;
      if (endIn > 0 && startIn <= 30 * 60) out.push({ date: addDays(date, offset), slot: w.slot });
    }
  }
  return out;
}

const maxOf = (xs: (number | null | undefined)[]) => {
  const v = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return v.length ? Math.max(...v) : null;
};

/** Decides alerts for the given targets. Missing data never raises an alert. */
export function decideAlerts(
  forecast: Forecast,
  targets: { date: string; slot: Slot }[],
  windows: SlotWindow[] = DEFAULT_WINDOWS,
  t: Thresholds = THRESHOLDS,
): Decision[] {
  const h = forecast?.hourly;
  if (!h || !Array.isArray(h.time)) return [];
  const out: Decision[] = [];
  for (const target of targets) {
    const w = windows.find((x) => x.slot === target.slot);
    if (!w) continue;
    const idx: number[] = [];
    h.time.forEach((iso, i) => {
      if (typeof iso !== 'string' || iso.slice(0, 10) !== target.date) return;
      const m = minutes(iso.slice(11, 16));
      if (m + 59 >= minutes(w.start) && m < minutes(w.end)) idx.push(i);
    });
    if (!idx.length) continue;
    const pick = (arr?: (number | null)[]) => idx.map((i) => arr?.[i] ?? null);
    const rain = pick(h.precipitation);
    const prob = pick(h.precipitation_probability);
    const temp = pick(h.temperature_2m);
    const feels = pick(h.apparent_temperature);
    const code = pick(h.weather_code);
    const rainy = idx.some((_, j) =>
      (rain[j] ?? 0) >= t.rainMmPerHour
      || (code[j] != null && t.stormCodes.includes(code[j] as number) && (prob[j] == null || (prob[j] as number) >= t.stormProbabilityPct)));
    const hot = (maxOf(temp) ?? -99) >= t.heatTempC || (maxOf(feels) ?? -99) >= t.heatFeelsC;
    if (!rainy && !hot) continue;
    out.push({
      date: target.date,
      slot: target.slot,
      kind: rainy && hot ? 'rain_heat' : rainy ? 'rain' : 'heat',
      detail: {
        max_rain_mm: maxOf(rain),
        max_probability: maxOf(prob),
        max_temp_c: maxOf(temp),
        max_feels_c: maxOf(feels),
        hours: idx.map((i) => h.time[i]!.slice(11, 16)),
      },
    });
  }
  return out;
}

/** A deterministic forecast for tests and local runs (no network). */
export function mockForecast(dates: string[], scenario: MockScenario = 'none'): Forecast {
  const time: string[] = [];
  const precipitation: number[] = [];
  const precipitation_probability: number[] = [];
  const temperature_2m: number[] = [];
  const apparent_temperature: number[] = [];
  const weather_code: number[] = [];
  for (const d of dates) {
    for (let hr = 0; hr < 24; hr++) {
      time.push(`${d}T${String(hr).padStart(2, '0')}:00`);
      const midday = hr >= 11 && hr <= 15;
      const evening = hr >= 18 && hr <= 21;
      precipitation.push(scenario === 'rain' && (midday || evening) ? 12 : 0);
      precipitation_probability.push(scenario === 'rain' && (midday || evening) ? 90 : 5);
      temperature_2m.push(scenario === 'heat' && midday ? 42 : 30);
      apparent_temperature.push(scenario === 'heat' && midday ? 47 : 33);
      weather_code.push(scenario === 'rain' && (midday || evening) ? 95 : 1);
    }
  }
  return { hourly: { time, precipitation, precipitation_probability, temperature_2m, apparent_temperature, weather_code } };
}
