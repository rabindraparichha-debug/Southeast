'use client';

import { useEffect, useRef } from 'react';

// Cloudflare Turnstile widget for the public forms (D-183). Rendered only when the site key is set
// (NEXT_PUBLIC_TURNSTILE_SITE_KEY); without it (local stacks) the form works without a CAPTCHA and
// the Edge Function skips the check locally only. A token is single use: the form resets the widget
// (by changing `resetKey`) after each submission.

type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  remove: (id: string) => void;
};
declare global {
  interface Window { turnstile?: TurnstileApi }
}

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

function loadScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT}"]`);
  if (existing) return new Promise((resolve) => existing.addEventListener('load', () => resolve(), { once: true }));
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('turnstile_load_failed'));
    document.head.appendChild(s);
  });
}

export function Turnstile({ siteKey, onToken, resetKey = 0 }: { siteKey: string | null; onToken: (token: string | null) => void; resetKey?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!siteKey || !ref.current) return;
    let id: string | null = null;
    let cancelled = false;
    onToken(null);
    loadScript().then(() => {
      if (cancelled || !ref.current || !window.turnstile) return;
      id = window.turnstile.render(ref.current, {
        sitekey: siteKey,
        callback: (token: string) => onToken(token),
        'expired-callback': () => onToken(null),
        'error-callback': () => onToken(null),
      });
    }, () => onToken(null));
    return () => {
      cancelled = true;
      if (id && window.turnstile) window.turnstile.remove(id);
    };
  }, [siteKey, resetKey, onToken]);
  if (!siteKey) return null;
  return <div ref={ref} className="min-h-[65px]" data-testid="turnstile" />;
}
