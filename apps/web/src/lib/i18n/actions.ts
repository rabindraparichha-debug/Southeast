'use server';

import { cookies } from 'next/headers';
import { LANG_COOKIE, isLang } from './translate';

/** Saves the vendor's language on this browser for a year (D-130). Unknown values are ignored. */
export async function setLanguage(lang: string) {
  if (!isLang(lang)) return;
  (await cookies()).set(LANG_COOKIE, lang, { sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 365 });
}
