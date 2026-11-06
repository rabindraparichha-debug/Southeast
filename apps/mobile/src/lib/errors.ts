import { t } from '@/i18n';
import { isOfflineError } from './screen-cache';

/** Database functions raise short codes; show vendor-facing text. */
export function friendlyError(error: { message?: string; code?: string } | null | undefined): string {
  if (!error) return '';
  const key = `errors.${error.message}`;
  const text = t(key);
  if (text !== key) return text;
  if (isOfflineError(error)) return t('errors.network'); // no answer from the server (no signal, timed out)
  if (error.code === '42501') return t('errors.forbidden');
  return error.message || t('errors.generic');
}
