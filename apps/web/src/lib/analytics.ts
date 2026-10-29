// Optional product analytics with PostHog (D-092), web only.
// - Off unless NEXT_PUBLIC_POSTHOG_KEY is set; posthog-js is loaded lazily only then.
// - Off for visitors with Do Not Track or Global Privacy Control.
// - Only page views and four funnel events. Properties are an allow-list (source, campaign, area,
//   kitchen slug): never names, phone numbers, addresses or customer-page tokens.
// - No autocapture, session recording, surveys or person profiles.
import type { PostHog } from 'posthog-js';

export type FunnelEvent = 'lead_submitted' | 'kitchen_picked' | 'trial_payment_started' | 'vendor_applied';
export type FunnelProps = { source?: string | null; campaign?: string | null; area?: string | null; kitchen?: string | null };

const KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY ?? '';
const HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://eu.i.posthog.com';

let client: Promise<PostHog | null> | null = null;

function doNotTrack(): boolean {
  if (typeof navigator === 'undefined') return true;
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean; msDoNotTrack?: string };
  const w = window as Window & { doNotTrack?: string };
  return nav.doNotTrack === '1' || nav.doNotTrack === 'yes' || w.doNotTrack === '1' || nav.msDoNotTrack === '1' || nav.globalPrivacyControl === true;
}

export function analyticsEnabled(): boolean {
  return Boolean(KEY) && typeof window !== 'undefined' && !doNotTrack();
}

/** Removes customer-page tokens and every query parameter except campaign ones (utm_*, src, c). */
export function cleanUrl(url: string): string {
  if (!/^(https?:\/\/|\/)/.test(url)) return url; // e.g. PostHog's "$direct" referrer
  try {
    const u = new URL(url, 'http://x');
    const keep = new URLSearchParams();
    u.searchParams.forEach((v, k) => { if (/^(utm_\w+|src|source|c|campaign)$/.test(k)) keep.set(k, v.slice(0, 100)); });
    const path = u.pathname.replace(/\/c\/[^/]+/, '/c/[token]');
    const qs = keep.toString();
    return (url.startsWith('http') ? u.origin : '') + path + (qs ? `?${qs}` : '');
  } catch {
    return '';
  }
}

const URL_PROPS = ['$current_url', '$referrer', '$initial_referrer', '$initial_current_url', '$session_entry_url', '$prev_pageview_pathname'];
const PATH_PROPS = ['$pathname', '$initial_pathname', '$session_entry_pathname'];

function load(): Promise<PostHog | null> {
  if (!analyticsEnabled()) return Promise.resolve(null);
  client ??= import('posthog-js')
    .then(({ default: posthog }) => {
      posthog.init(KEY, {
        api_host: HOST,
        capture_pageview: false,
        capture_pageleave: false,
        autocapture: false,
        disable_session_recording: true,
        disable_surveys: true,
        advanced_disable_flags: true,
        capture_exceptions: false,
        capture_heatmaps: false,
        capture_dead_clicks: false,
        person_profiles: 'never',
        respect_dnt: true,
        persistence: 'localStorage',
        before_send: (event) => {
          if (!event) return null;
          const p = event.properties ?? {};
          for (const k of URL_PROPS) if (typeof p[k] === 'string') p[k] = cleanUrl(p[k]);
          for (const k of PATH_PROPS) if (typeof p[k] === 'string') p[k] = cleanUrl(p[k]);
          return event;
        },
      });
      return posthog;
    })
    .catch(() => null);
  return client;
}

/** Page view for the given path (query strings are dropped except campaign parameters). */
export function trackPageview(path: string): void {
  void load().then((ph) => ph?.capture('$pageview', { $current_url: cleanUrl(window.location.origin + path) }));
}

/** A funnel event with allow-listed properties only. */
export function track(event: FunnelEvent, props: FunnelProps = {}, opts: { beforeNavigation?: boolean } = {}): void {
  const safe: Record<string, string> = {};
  for (const k of ['source', 'campaign', 'area', 'kitchen'] as const) {
    const v = props[k];
    if (typeof v === 'string' && v.trim()) safe[k] = v.trim().slice(0, 80);
  }
  void load().then((ph) => ph?.capture(event, safe, opts.beforeNavigation ? { send_instantly: true, transport: 'sendBeacon' } : undefined));
}
