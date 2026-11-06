import { cookies } from 'next/headers';
import { LANG_COOKIE, isLang, translator, type Lang, type Translate } from './translate';

/** The vendor's language on this browser (tiffin_lang cookie), English by default. D-128. */
export async function getLang(): Promise<Lang> {
  const value = (await cookies()).get(LANG_COOKIE)?.value;
  return isLang(value) ? value : 'en';
}

/** The language and its translator, for a server page. */
export async function getTranslator(): Promise<{ lang: Lang; t: Translate }> {
  const lang = await getLang();
  return { lang, t: translator(lang) };
}
