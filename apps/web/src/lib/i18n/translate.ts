// Tiny i18n helper for the web vendor app (draft rollout D-128). Pure: no browser or server imports,
// so server pages, client components and the unit tests share it. The language comes from the
// tiffin_lang cookie (lib/i18n/server.ts); unknown keys fall back to English.
import { WEB_EN, type WebKey } from './en';
import { WEB_HI } from './hi';
import { WEB_OR } from './or';

export type Lang = 'en' | 'or' | 'hi';
export const LANG_COOKIE = 'tiffin_lang';
/** Each language named in its own script, for the picker. */
export const LANGS: readonly { code: Lang; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'or', label: 'ଓଡ଼ିଆ' },
  { code: 'hi', label: 'हिन्दी' },
];
const DICTS: Record<Lang, Partial<Record<WebKey, string>>> = { en: WEB_EN, or: WEB_OR, hi: WEB_HI };
const LOCALES: Record<Lang, string> = { en: 'en-IN', or: 'or-IN', hi: 'hi-IN' };

export function isLang(v: unknown): v is Lang {
  return v === 'en' || v === 'or' || v === 'hi';
}

/** BCP 47 locale for dates ("or-IN"). */
export function localeOf(lang: Lang): string {
  return LOCALES[lang];
}

export type Translate = (key: WebKey, vars?: Record<string, string | number>) => string;

/** t('today.paused', { n: 2 }) in the given language. */
export function translator(lang: Lang): Translate {
  const dict = DICTS[lang] ?? WEB_EN;
  return (key, vars) => {
    let text: string = dict[key] ?? WEB_EN[key] ?? key;
    if (vars) for (const [name, value] of Object.entries(vars)) text = text.replaceAll(`{${name}}`, String(value));
    return text;
  };
}

// Sidebar entries by link. An entry not listed here (added later) keeps its English label.
const NAV_KEYS: Record<string, WebKey> = {
  '/': 'nav.today', '/customers': 'nav.customers', '/sheet': 'nav.sheet', '/delivery': 'nav.delivery', '/rider': 'nav.deliver',
  '/menu': 'nav.menu', '/inventory': 'nav.inventory', '/stock-entry': 'nav.stockEntry', '/inbox': 'nav.inbox', '/money': 'nav.money',
  '/reports/costs': 'nav.costs', '/insights': 'nav.insights', '/plans': 'nav.plans', '/settings': 'nav.settings', '/team': 'nav.team',
  '/admin': 'nav.admin',
};

/**
 * Translates sidebar labels by their link. A suffix after the English label (the inbox count,
 * "Inbox (3)") is kept; a label that no longer starts with the English text is left alone.
 */
export function translateNav<T extends { href: string; label: string }>(items: readonly T[], lang: Lang): T[] {
  if (lang === 'en') return [...items];
  const t = translator(lang);
  return items.map((item) => {
    const key = NAV_KEYS[item.href];
    const english = key ? WEB_EN[key] : undefined;
    if (!key || !english || !item.label.startsWith(english)) return item;
    return { ...item, label: t(key) + item.label.slice(english.length) };
  });
}

export { WEB_EN, WEB_HI, WEB_OR, type WebKey };
