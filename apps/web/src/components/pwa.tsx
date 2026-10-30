'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';

// Installable app support: service worker registration (production builds only) and the
// "Install app" button (Android/desktop Chrome prompt, or instructions for iPhone Safari).

type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
declare global {
  interface Window {
    __tiffinInstall?: InstallPromptEvent | null;
  }
}

/** Inline script for <head>: keeps the install prompt event if it fires before React has loaded. */
export const INSTALL_CAPTURE_SCRIPT = `window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();window.__tiffinInstall=e;window.dispatchEvent(new Event('tiffin-install'))});window.addEventListener('appinstalled',function(){window.__tiffinInstall=null;window.dispatchEvent(new Event('tiffin-install'))});`;

/** Registers /sw.js and hands it the files this page already loaded, so they work offline too. */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    let cancelled = false;
    const sendAssets = (sw: ServiceWorker | null | undefined) => {
      if (!sw) return;
      const urls = performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .filter((u) => u.startsWith(location.origin) && new URL(u).pathname.startsWith('/_next/static/'));
      sw.postMessage({ type: 'cache-assets', urls });
      // Rider mode and stock entry: cache their pages while we are online and logged in.
      if (!location.pathname.startsWith('/login') && !location.pathname.startsWith('/c')) sw.postMessage({ type: 'warm' });
    };
    navigator.serviceWorker
      .register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then(async () => {
        const reg = await navigator.serviceWorker.ready;
        if (!cancelled) sendAssets(reg.active);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}

/** Drops cached pages on log-out so the next person on this phone does not see them. */
export async function clearOfflinePages() {
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    reg?.active?.postMessage({ type: 'clear-pages' });
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('tiffin-pages')).map((k) => caches.delete(k)));
    }
  } catch {
    // best effort
  }
}

const subscribeInstall = (cb: () => void) => {
  window.addEventListener('tiffin-install', cb);
  return () => window.removeEventListener('tiffin-install', cb);
};

function useInstallEvent() {
  return useSyncExternalStore(subscribeInstall, () => window.__tiffinInstall ?? null, () => null);
}

const subscribeNone = () => () => undefined;

function useInstallState() {
  // Browser-only facts; null on the server and during hydration.
  return useSyncExternalStore(
    subscribeNone,
    () => {
      const standalone =
        window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
      const ua = navigator.userAgent;
      const ios = /iphone|ipad|ipod/i.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
      return standalone ? 'standalone' : ios ? 'ios' : 'other';
    },
    () => null,
  );
}

const DISMISS_KEY = 'tiffin.install.dismissed';
const dismissListeners = new Set<() => void>();
const subscribeDismiss = (cb: () => void) => {
  dismissListeners.add(cb);
  return () => {
    dismissListeners.delete(cb);
  };
};
function readDismissed() {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * "Install app" for the sidebar (variant="button") or a dismissible banner on the phone pages.
 * Hidden when already installed or when the browser cannot install.
 */
export function InstallApp({ variant = 'button' }: { variant?: 'button' | 'banner' }) {
  const prompt = useInstallEvent();
  const mode = useInstallState();
  const [showIos, setShowIos] = useState(false);
  const dismissed = useSyncExternalStore(subscribeDismiss, readDismissed, () => true);

  if (mode === null || mode === 'standalone') return null;
  if (mode === 'other' && !prompt) return null;
  if (variant === 'banner' && dismissed) return null;

  const install = async () => {
    if (prompt) {
      await prompt.prompt();
      await prompt.userChoice.catch(() => null);
      window.__tiffinInstall = null;
      window.dispatchEvent(new Event('tiffin-install'));
    } else {
      setShowIos((v) => !v);
    }
  };
  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // ignore
    }
    dismissListeners.forEach((l) => l());
  };

  const iosHelp = showIos && (
    <p className="mt-2 rounded-lg bg-white p-3 text-sm text-ink-700 ring-1 ring-ink-200" data-testid="ios-install-help">
      In Safari, tap the <strong>Share</strong> button <span aria-hidden>(□↑)</span>, scroll down and tap{' '}
      <strong>Add to Home Screen</strong>, then <strong>Add</strong>.
    </p>
  );

  if (variant === 'banner') {
    return (
      <div className="rounded-xl bg-brand-50 p-3 ring-1 ring-brand-100" data-testid="install-banner">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-white" aria-hidden>📲</span>
          <p className="min-w-0 flex-1 text-sm text-ink-800">Install Tiffin OS on this phone. It opens like an app and works offline.</p>
          <button onClick={install} className="shrink-0 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white">Install</button>
          <button onClick={dismiss} className="shrink-0 px-1 text-lg leading-none text-ink-400" aria-label="Dismiss">×</button>
        </div>
        {iosHelp}
      </div>
    );
  }
  return (
    <div>
      <button onClick={install} className="flex items-center gap-2 text-sm font-medium text-brand-700 hover:text-brand-800" data-testid="install-button">
        <span aria-hidden>📲</span> Install app
      </button>
      {iosHelp}
    </div>
  );
}
