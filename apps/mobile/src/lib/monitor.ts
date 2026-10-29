// Crash and error reporting to Sentry without a native SDK (works in Expo Go and EAS builds).
// No-op unless EXPO_PUBLIC_SENTRY_DSN is set. Phone numbers are masked before sending.
import Constants from 'expo-constants';
import { Platform } from 'react-native';

const DSN = process.env.EXPO_PUBLIC_SENTRY_DSN ?? '';
const parsed = /^(https?):\/\/([^@]+)@([^/]+)\/(\d+)$/.exec(DSN.trim());
const PHONE = /(\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}/g;

const scrub = (s: string) => s.replace(PHONE, '[phone]');
const id = () => Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');

export function reportError(error: unknown, tags: Record<string, string> = {}): void {
  if (!parsed) return;
  const [, protocol, key, host, project] = parsed;
  const e = error instanceof Error ? error : new Error(String(error));
  const eventId = id();
  const now = new Date().toISOString();
  const event = {
    event_id: eventId, timestamp: now, platform: 'javascript', level: 'error',
    environment: __DEV__ ? 'development' : 'production',
    release: `tiffin-mobile@${Constants.expoConfig?.version ?? '0'}`,
    tags: { os: Platform.OS, ...tags },
    exception: { values: [{ type: e.name || 'Error', value: scrub(e.message),
      stacktrace: e.stack ? { frames: e.stack.split('\n').slice(0, 30).reverse().map((l) => ({ function: scrub(l.trim()) })) } : undefined }] },
  };
  const body = [JSON.stringify({ event_id: eventId, sent_at: now, dsn: DSN }), JSON.stringify({ type: 'event' }), JSON.stringify(event)].join('\n');
  fetch(`${protocol}://${host}/api/${project}/envelope/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-sentry-envelope', 'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${key}, sentry_client=tiffin-mobile/1.0` },
    body,
  }).catch(() => undefined);
}

type GlobalHandler = (error: unknown, isFatal?: boolean) => void;
type ErrorUtilsT = { getGlobalHandler: () => GlobalHandler; setGlobalHandler: (h: GlobalHandler) => void };

/** Report uncaught JS errors, then let React Native handle them as before. */
export function installGlobalErrorHandler(): void {
  const eu = (globalThis as { ErrorUtils?: ErrorUtilsT }).ErrorUtils;
  if (!parsed || !eu) return;
  const previous = eu.getGlobalHandler();
  eu.setGlobalHandler((error, isFatal) => {
    reportError(error, { fatal: String(Boolean(isFatal)) });
    previous(error, isFatal);
  });
}
