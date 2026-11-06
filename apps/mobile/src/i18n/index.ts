import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';
import { en, type MessageKey } from './en';
import { hi } from './hi';
import { or } from './or';

// Odia and Hindi are partial dictionaries; missing keys fall back to English. They are DRAFTS until a
// native speaker reviews them (docs/DECISIONS.md D-006, draft rollout D-130). The choice is saved on
// this phone only (there is no language column on members).
export type Language = 'en' | 'or' | 'hi';
const dictionaries: Record<Language, Partial<Record<MessageKey, string>>> = { en, or, hi };

/** Each language named in its own script, for the picker. */
export const LANGUAGES: readonly { code: Language; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'or', label: 'ଓଡ଼ିଆ' },
  { code: 'hi', label: 'हिन्दी' },
];
const LOCALES: Record<Language, string> = { en: 'en-IN', or: 'or-IN', hi: 'hi-IN' };
const STORAGE_KEY = 'tiffin.language';

let current: Language = 'en';
const listeners = new Set<() => void>();

const isLanguage = (v: unknown): v is Language => v === 'en' || v === 'or' || v === 'hi';

export function setLanguage(lang: Language) {
  if (lang === current) return;
  current = lang;
  listeners.forEach((l) => l());
}

export function getLanguage(): Language {
  return current;
}

/** BCP 47 locale for dates and numbers ("or-IN"), for the @tiffin/core formatters. */
export function locale(): string {
  return LOCALES[current];
}

/** Reads the language saved on this phone (English when nothing is saved or storage fails). */
export async function loadLanguage(): Promise<Language> {
  try {
    const saved = await AsyncStorage.getItem(STORAGE_KEY);
    if (isLanguage(saved)) setLanguage(saved);
  } catch {
    // English
  }
  return current;
}

/** Switches the app's language and saves it for next time. */
export async function chooseLanguage(lang: Language): Promise<void> {
  setLanguage(lang);
  try {
    await AsyncStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // still switched for this session
  }
}

/** Re-renders the caller when the language changes. */
export function useLanguage(): Language {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

/** t('login.otpSentTo', { phone }) — unknown keys are returned as-is. */
export function t(key: MessageKey | string, vars?: Record<string, string | number>): string {
  const k = key as MessageKey;
  let text: string = dictionaries[current][k] ?? en[k] ?? key;
  if (vars) for (const [name, value] of Object.entries(vars)) text = text.replace(`{${name}}`, String(value));
  return text;
}
