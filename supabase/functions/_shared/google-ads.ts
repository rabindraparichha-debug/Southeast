// Google Ads offline click conversions: tell Google which ad clicks became paying customers
// (paid trial, plan, month-2 renewal), so Smart Bidding optimises for them instead of form fills.
// API: customers/{id}:uploadClickConversions (https://developers.google.com/google-ads/api/docs/conversions/upload-clicks).
// No external imports (unit-tested in tests/integration/lead-channels.test.ts).

export type AdsConfig = {
  mode: 'mock' | 'live';
  customerId: string;          // 10 digits, no dashes
  loginCustomerId?: string;    // manager (MCC) account, if any
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  apiVersion: string;          // e.g. v21
  actions: { trial?: string; plan?: string; renewal?: string };  // conversion action ids
};

export type PendingConversion = { id: string; gclid: string; stage: 'trial' | 'plan' | 'renewal'; value_paise: number; occurred_at: string };

export function loadAdsConfig(env: (k: string) => string | undefined): AdsConfig {
  const developerToken = env('GOOGLE_ADS_DEVELOPER_TOKEN') ?? '';
  const live = env('GOOGLE_ADS_MODE') === 'live' && developerToken !== '';
  return {
    mode: live ? 'live' : 'mock',
    customerId: (env('GOOGLE_ADS_CUSTOMER_ID') ?? '').replace(/-/g, ''),
    loginCustomerId: env('GOOGLE_ADS_LOGIN_CUSTOMER_ID')?.replace(/-/g, '') || undefined,
    developerToken,
    clientId: env('GOOGLE_ADS_CLIENT_ID') ?? '',
    clientSecret: env('GOOGLE_ADS_CLIENT_SECRET') ?? '',
    refreshToken: env('GOOGLE_ADS_REFRESH_TOKEN') ?? '',
    apiVersion: env('GOOGLE_ADS_API_VERSION') ?? 'v21',
    actions: {
      trial: env('GOOGLE_ADS_CONVERSION_TRIAL') || undefined,
      plan: env('GOOGLE_ADS_CONVERSION_PLAN') || undefined,
      renewal: env('GOOGLE_ADS_CONVERSION_RENEWAL') || undefined,
    },
  };
}

/** Google wants "yyyy-mm-dd hh:mm:ss+05:30"; we report in IST. */
export function adsDateTime(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 330 * 60_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+05:30`;
}

/** Splits pending rows into an upload body and the rows we can't send (no action id for that stage). */
export function buildUpload(cfg: AdsConfig, rows: PendingConversion[]) {
  const sendable = rows.filter((r) => cfg.actions[r.stage]);
  const skipped = rows.filter((r) => !cfg.actions[r.stage]);
  return {
    sendable,
    skipped,
    body: {
      conversions: sendable.map((r) => ({
        gclid: r.gclid,
        conversionAction: `customers/${cfg.customerId}/conversionActions/${cfg.actions[r.stage]}`,
        conversionDateTime: adsDateTime(r.occurred_at),
        conversionValue: Math.round(r.value_paise) / 100,
        currencyCode: 'INR',
      })),
      partialFailure: true,
    },
  };
}

/** Indexes of conversions Google rejected, from a partial-failure response. */
export function failedIndexes(res: { partialFailureError?: { details?: { errors?: { location?: { fieldPathElements?: { index?: number }[] }; message?: string }[] }[] } }): Map<number, string> {
  const out = new Map<number, string>();
  for (const d of res.partialFailureError?.details ?? []) {
    for (const e of d.errors ?? []) {
      const idx = e.location?.fieldPathElements?.find((f) => typeof f.index === 'number')?.index;
      if (typeof idx === 'number') out.set(idx, e.message ?? 'rejected');
    }
  }
  return out;
}

export async function accessToken(cfg: AdsConfig, fetchFn: typeof fetch = fetch): Promise<string> {
  const res = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: cfg.refreshToken, grant_type: 'refresh_token' }),
  });
  if (!res.ok) throw new Error(`google_oauth_${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/** Uploads; returns per-row outcome. Mock mode accepts everything without calling Google. */
export async function uploadConversions(cfg: AdsConfig, rows: PendingConversion[], fetchFn: typeof fetch = fetch):
  Promise<{ id: string; ok: boolean; skip?: boolean; error?: string }[]> {
  const { sendable, skipped, body } = buildUpload(cfg, rows);
  const results = skipped.map((r) => ({ id: r.id, ok: false, skip: true, error: `no conversion action for ${r.stage}` }));
  if (!sendable.length) return results;
  if (cfg.mode === 'mock') return [...results, ...sendable.map((r) => ({ id: r.id, ok: true, error: 'mock' }))];
  const token = await accessToken(cfg, fetchFn);
  const res = await fetchFn(`https://googleads.googleapis.com/${cfg.apiVersion}/customers/${cfg.customerId}:uploadClickConversions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`, 'developer-token': cfg.developerToken, 'Content-Type': 'application/json',
      ...(cfg.loginCustomerId ? { 'login-customer-id': cfg.loginCustomerId } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const msg = `google_ads_${res.status}`;
    return [...results, ...sendable.map((r) => ({ id: r.id, ok: false, error: msg }))];
  }
  const failed = failedIndexes(await res.json());
  return [...results, ...sendable.map((r, i) => (failed.has(i) ? { id: r.id, ok: false, error: failed.get(i) } : { id: r.id, ok: true }))];
}
