// Unit tests for the P5/P6 Edge Function modules (no network): weather decisions, notebook-import
// guardrails, the Route split with commission, and the new WhatsApp templates.
import { describe, expect, it } from 'vitest';
import { normalizePhone as corePhone } from '@tiffin/core';
import {
  decideAlerts, istParts, loadWeatherConfig, mockForecast, openMeteoUrl, targetSlots, THRESHOLDS, type Forecast,
} from '../../supabase/functions/_shared/weather.ts';
import {
  buildPreview, matchPlan, MOCK_MODEL_OUTPUT, normalizePhone, parseModelOutput,
} from '../../supabase/functions/_shared/notebook.ts';
import { createPaymentLink, loadConfig, paymentLinkBody, routeTransfer } from '../../supabase/functions/_shared/razorpay.ts';
import { renderOutbox, TEMPLATES } from '../../supabase/functions/_shared/templates.ts';

const hours = (date: string, values: Partial<Record<keyof Forecast['hourly'], (h: number) => number | null>>): Forecast => {
  const time = Array.from({ length: 24 }, (_, h) => `${date}T${String(h).padStart(2, '0')}:00`);
  const col = (f?: (h: number) => number | null) => (f ? time.map((_, h) => f(h)) : undefined);
  return { hourly: { time, precipitation: col(values.precipitation), precipitation_probability: col(values.precipitation_probability),
    temperature_2m: col(values.temperature_2m), apparent_temperature: col(values.apparent_temperature), weather_code: col(values.weather_code) } };
};

describe('weather: which slots to check', () => {
  it('converts to IST', () => {
    expect(istParts(new Date('2026-11-02T00:30:00Z'))).toEqual({ date: '2026-11-02', minute: 360 });
  });
  it('06:00 IST: today lunch and dinner, tomorrow lunch', () => {
    expect(targetSlots(new Date('2026-11-02T00:30:00Z'))).toEqual([
      { date: '2026-11-02', slot: 'lunch' }, { date: '2026-11-02', slot: 'dinner' }, { date: '2026-11-03', slot: 'lunch' },
    ]);
  });
  it('16:00 IST: today dinner, tomorrow lunch and dinner', () => {
    expect(targetSlots(new Date('2026-11-02T10:30:00Z'))).toEqual([
      { date: '2026-11-02', slot: 'dinner' }, { date: '2026-11-03', slot: 'lunch' }, { date: '2026-11-03', slot: 'dinner' },
    ]);
  });
});

describe('weather: decisions', () => {
  const t = [{ date: '2026-11-02', slot: 'lunch' as const }, { date: '2026-11-02', slot: 'dinner' as const }];
  it('mock scenarios', () => {
    expect(decideAlerts(mockForecast(['2026-11-02'], 'none'), t)).toEqual([]);
    expect(decideAlerts(mockForecast(['2026-11-02'], 'rain'), t).map((d) => `${d.slot}:${d.kind}`)).toEqual(['lunch:rain', 'dinner:rain']);
    const heat = decideAlerts(mockForecast(['2026-11-02'], 'heat'), t);
    expect(heat.map((d) => `${d.slot}:${d.kind}`)).toEqual(['lunch:heat']);
    expect(heat[0]!.detail).toMatchObject({ max_temp_c: 42, max_feels_c: 47, hours: ['11:00', '12:00', '13:00'] });
  });
  it('heavy-rain threshold is 7.5 mm in an hour of the window', () => {
    const at = (mm: number) => hours('2026-11-02', { precipitation: (h) => (h === 12 ? mm : 0) });
    expect(decideAlerts(at(THRESHOLDS.rainMmPerHour - 0.1), t)).toEqual([]);
    expect(decideAlerts(at(THRESHOLDS.rainMmPerHour), t)[0]).toMatchObject({ slot: 'lunch', kind: 'rain' });
    // Outside the delivery windows: no alert.
    expect(decideAlerts(hours('2026-11-02', { precipitation: (h) => (h === 16 ? 30 : 0) }), t)).toEqual([]);
  });
  it('thunderstorm codes need a likely probability', () => {
    const storm = (p: number) => hours('2026-11-02', { weather_code: (h) => (h === 20 ? 95 : 1), precipitation_probability: () => p });
    expect(decideAlerts(storm(40), t)).toEqual([]);
    expect(decideAlerts(storm(80), t)[0]).toMatchObject({ slot: 'dinner', kind: 'rain' });
  });
  it('rain and heat together, and missing data never alerts', () => {
    const both = hours('2026-11-02', { precipitation: (h) => (h === 12 ? 10 : 0), temperature_2m: (h) => (h === 13 ? 41 : 30) });
    expect(decideAlerts(both, t)[0]!.kind).toBe('rain_heat');
    expect(decideAlerts({ hourly: { time: [] } }, t)).toEqual([]);
    expect(decideAlerts({} as Forecast, t)).toEqual([]);
    expect(decideAlerts(hours('2026-11-02', { precipitation: () => null }), t)).toEqual([]);
  });
  it('config and URL', () => {
    expect(loadWeatherConfig(() => undefined)).toMatchObject({ mode: 'mock', scenario: 'none' });
    expect(() => loadWeatherConfig((k) => (k === 'WEATHER_MODE' ? 'prod' : undefined))).toThrow(/WEATHER_MODE/);
    const url = openMeteoUrl('https://api.open-meteo.com/v1/forecast', 20.3553, 85.8197);
    expect(url).toContain('latitude=20.3553');
    expect(url).toContain('timezone=Asia%2FKolkata');
    expect(url).not.toMatch(/key|apikey/i);
  });
});

describe('notebook import guardrails', () => {
  it('phone rules match @tiffin/core exactly', () => {
    for (const v of ['98610 12345', '+91 98610-12345', '919861012345', '09861012345', '5861012345', '98610', '', null, 9861012345, 'abc']) {
      expect(normalizePhone(v)).toBe(corePhone(v as string));
    }
  });
  it('reads JSON, fenced JSON or a bare array; refuses anything else', () => {
    expect(parseModelOutput('{"rows":[{"name":"A"}]}')).toHaveLength(1);
    expect(parseModelOutput('Here:\n```json\n[{"name":"A"},{"name":"B"}]\n```')).toHaveLength(2);
    expect(() => parseModelOutput('I could not read it')).toThrow('unreadable_output');
    expect(() => parseModelOutput('{"customers":[]}')).toThrow('unreadable_output');
  });
  it('flags problems and never invents values', () => {
    const p = buildPreview(parseModelOutput(MOCK_MODEL_OUTPUT), { plans: ['Veg Lunch', 'Non-veg Lunch'] });
    expect(p.summary).toEqual({ total: 4, importable: 2, flagged: 2, with_balance_suggestion: 2 });
    expect(p.rows[0]).toMatchObject({ name: 'Ramesh Panda', phone: '+919861012345', plan: 'Veg Lunch', suggested_balance_meals: 12,
      flags: ['check_balance'], importable: true });
    expect(p.rows[1]).toMatchObject({ phone: '+919437022222', plan: null, notes: 'no onion', importable: true });
    expect(p.rows[2]!.flags).toEqual(expect.arrayContaining(['invalid_phone', 'low_confidence', 'check_balance']));
    expect(p.rows[2]).toMatchObject({ phone: null, phone_raw: '98610 1234', suggested_balance_meals: 5, importable: false });
    expect(p.rows[3]).toMatchObject({ name: null, line1: 'Room 7', area: null, importable: false });
    // Balances are suggestions only: never part of what is imported.
    expect(p.import_rows).toEqual([
      { name: 'Ramesh Panda', phone: '+919861012345', line1: 'Flat 2B', area: 'Patia', plan: 'Veg Lunch' },
      { name: 'Sunita Behera', phone: '+919437022222', line1: 'House 14', area: 'KIIT Square', notes: 'no onion' },
    ]);
  });
  it('duplicates, odd values and confidence', () => {
    const p = buildPreview([
      { name: 'A', phone: '9861000001', confidence: 2, meals_left: 'lots' },
      { name: 'B', phone: '98610 00001', confidence: 0.9, plan: 'Thali' },
      { name: '  ', phone: { x: 1 }, notes: 'N/A', confidence: 'high' },
    ], { plans: ['Veg Lunch'] });
    expect(p.rows[0]).toMatchObject({ confidence: 1, suggested_balance_meals: null });
    expect(p.rows[0]!.flags).toContain('invalid_meals_left');
    expect(p.rows[1]!.flags).toEqual(expect.arrayContaining(['duplicate_phone', 'unknown_plan']));
    expect(p.rows[1]!.importable).toBe(false);
    expect(p.rows[2]).toMatchObject({ name: null, phone_raw: null, notes: null, confidence: null });
    expect(p.rows[2]!.flags).toEqual(expect.arrayContaining(['missing_name', 'missing_phone', 'low_confidence']));
  });
  it('plan matching is exact or a single unambiguous match', () => {
    expect(matchPlan('veg lunch', ['Veg Lunch', 'Non-veg Lunch'])).toBe('Veg Lunch');
    expect(matchPlan('lunch', ['Veg Lunch', 'Non-veg Lunch'])).toBeNull();
    expect(matchPlan('non-veg', ['Veg Lunch', 'Non-veg Lunch'])).toBe('Non-veg Lunch');
    expect(matchPlan(null, ['Veg Lunch'])).toBeNull();
  });
});

describe('Route split with platform commission', () => {
  const input = { paymentId: 'p1', amountPaise: 70000, description: '10 meals', customerName: 'Pia', linkedAccountId: 'acc_X',
    kitchenName: 'K' };
  it('defaults to the whole amount for the kitchen (rate 0)', () => {
    expect(routeTransfer(70000, null, 'acc_X')).toEqual({ account: 'acc_X', amount: 70000, currency: 'INR', on_hold: 0 });
  });
  it('transfers amount minus commission', () => {
    const body = paymentLinkBody({ ...input, transferPaise: 63000 }, 1);
    expect(body).toMatchObject({ amount: 70000, options: { order: { transfers: [{ account: 'acc_X', amount: 63000 }] } } });
  });
  it('refuses a transfer above the amount or below 1 paisa', () => {
    expect(() => routeTransfer(70000, 70001, 'acc_X')).toThrow('invalid_transfer');
    expect(() => routeTransfer(70000, 0, 'acc_X')).toThrow('invalid_transfer');
  });
  it('mock mode validates too and never calls Razorpay', async () => {
    const cfg = loadConfig((k) => (k === 'RAZORPAY_WEBHOOK_SECRET' ? 's' : undefined));
    await expect(createPaymentLink(cfg, { ...input, transferPaise: 80000 })).rejects.toThrow('invalid_transfer');
    expect((await createPaymentLink(cfg, { ...input, transferPaise: 63000 })).shortUrl).toContain('razorpay-mock');
  });
});

describe('P5/P6 templates', () => {
  it('every template has a distinct Meta name', () => {
    const names = Object.values(TEMPLATES).map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
  it('payer variants name the eater and link the payer page', () => {
    const out = renderOutbox('low_balance_reminder_payer', { eater_name: 'Esha', balance_meals: 2, url: 'https://x/c/t' }, 'en', 'Maa Tarini', false);
    expect(out).toMatchObject({ type: 'template', name: 'low_balance_payer_v1', params: ['Maa Tarini', 'Esha', '2', 'https://x/c/t'] });
    const dues = renderOutbox('dues_reminder_payer', { eater_name: 'Esha', amount_owed_paise: 14000, meals_owed: 2, url: 'u' }, 'or', 'K', true);
    expect(dues).toMatchObject({ type: 'text' });
  });
  it('festival special, weather, late delivery, referral, switching', () => {
    expect(renderOutbox('festival_special', { name: 'Kheer', service_date: '2026-11-08', slot: 'lunch', addon_price_paise: 2000 }, 'en', 'K', false))
      .toMatchObject({ name: 'festival_special_v1', params: ['K', expect.any(String), 'lunch', 'Kheer', 'Add-on ₹20: message the kitchen to order.'] });
    expect((renderOutbox('weather_alert', { kind: 'rain_heat', slot: 'dinner', service_date: '2026-11-02', detail: { max_rain_mm: 12, max_temp_c: 41 } },
      'en', 'K', true) as { text: string }).text).toContain('Heavy rain and heat expected during dinner delivery');
    expect(renderOutbox('late_delivery_alert', { pending_stops: 3, route_name: 'Route 1', minutes: 90 }, 'en', 'K', false))
      .toMatchObject({ params: ['K', '3', 'Route 1', 'no rider', '90'] });
    expect((renderOutbox('referral_reward', { meals: 2, role: 'referrer', friend_name: 'Gita' }, 'en', 'K', true) as { text: string }).text)
      .toBe('K: thank you! 2 free meal(s) added to your balance because Gita joined with your code.');
    expect(renderOutbox('kitchen_switch_approved', { from_kitchen: 'A', effective_date: '2026-11-03', url: 'u' }, 'hi', 'B', false))
      .toMatchObject({ name: 'kitchen_switch_v1', language: 'hi' });
    expect(renderOutbox('complaint_credit', { category: 'quality', meals: 1 }, 'en', 'K', false)).toMatchObject({ name: 'complaint_credit_v1' });
  });
});
