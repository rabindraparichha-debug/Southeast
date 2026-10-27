import { t } from '@/i18n';

/** Database functions raise short codes; show vendor-facing text. */
export function friendlyError(error: { message?: string; code?: string } | null | undefined): string {
  if (!error) return '';
  const key = `errors.${error.message}`;
  const text = t(key);
  if (text !== key) return text;
  if (error.code === '42501') return t('errors.forbidden');
  return error.message || t('errors.generic');
}
