import { en, type MessageKey } from './en';

// Odia and Hindi are added as partial dictionaries; missing keys fall back to English.
// Translations need review by a native speaker before release (docs/DECISIONS.md D-006).
export type Language = 'en' | 'or' | 'hi';
const dictionaries: Record<Language, Partial<Record<MessageKey, string>>> = { en, or: {}, hi: {} };
let current: Language = 'en';

export function setLanguage(lang: Language) {
  current = lang;
}

/** t('login.otpSentTo', { phone }) — unknown keys are returned as-is. */
export function t(key: MessageKey | string, vars?: Record<string, string | number>): string {
  const k = key as MessageKey;
  let text: string = dictionaries[current][k] ?? en[k] ?? key;
  if (vars) for (const [name, value] of Object.entries(vars)) text = text.replace(`{${name}}`, String(value));
  return text;
}
