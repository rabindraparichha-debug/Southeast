'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setLanguage } from '@/lib/i18n/actions';
import { LANGS, translator, type Lang } from '@/lib/i18n/translate';

/**
 * Sidebar language picker (D-130). Odia and Hindi are drafts and cover the nav and Today page so far;
 * other pages stay in English.
 */
export function LanguagePicker({ current }: { current: Lang }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const t = translator(current);
  return (
    <label className="flex items-center gap-2 text-sm text-ink-500" title={t('nav.languageDraft')}>
      <span aria-hidden>🌐</span>
      <span className="sr-only">{t('nav.language')}</span>
      <select
        value={current}
        disabled={pending}
        aria-label={t('nav.language')}
        data-testid="language-picker"
        className="rounded-md border-0 bg-transparent py-1 pr-7 pl-1 text-sm ring-1 ring-ink-200"
        onChange={(e) => {
          const lang = e.target.value;
          start(async () => {
            await setLanguage(lang);
            router.refresh();
          });
        }}
      >
        {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
      </select>
    </label>
  );
}
