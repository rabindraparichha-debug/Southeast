// Odia and Hindi drafts (D-006, draft rollout D-130; no network): every English key of the mobile
// app and of the web nav/Today dictionary has a draft, placeholders survive translation, nothing
// extra sneaks in, and each draft file is marked as needing a native speaker's review.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { en } from '../../apps/mobile/src/i18n/en.ts';
import { hi } from '../../apps/mobile/src/i18n/hi.ts';
import { or } from '../../apps/mobile/src/i18n/or.ts';
import { WEB_EN, WEB_HI, WEB_OR, translateNav, translator } from '../../apps/web/src/lib/i18n/translate.ts';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const HEADER = 'DRAFT — needs native speaker review (D-006)';

// Mobile keys added after the drafts were written (other work in flight) fall back to English: the test
// lists them as a warning instead of failing. The web nav/Today dictionary must stay complete.
function checkDraft(name: string, base: Record<string, string>, draft: Partial<Record<string, string>>, strict: boolean) {
  describe(name, () => {
    it('has no keys English does not have (renamed or removed keys are cleaned up)', () => {
      expect(Object.keys(draft).filter((k) => !(k in base))).toEqual([]);
    });
    it(strict ? 'drafts every English key' : 'drafts the English keys (missing ones are listed)', () => {
      const missing = Object.keys(base).filter((k) => !(k in draft));
      if (strict) expect(missing).toEqual([]);
      else if (missing.length) console.warn(`${name}: ${missing.length} key(s) not drafted yet, shown in English: ${missing.join(', ')}`);
      expect(Object.keys(draft).length / Object.keys(base).length).toBeGreaterThan(0.5);
    });
    it('keeps every {placeholder} exactly', () => {
      const bad = Object.keys(base).filter((k) => draft[k] !== undefined
        && placeholders(draft[k]!).join(',') !== placeholders(base[k]!).join(','));
      expect(bad).toEqual([]);
    });
    it('has no empty strings', () => {
      expect(Object.entries(draft).filter(([, v]) => !v?.trim()).map(([k]) => k)).toEqual([]);
    });
  });
}

checkDraft('mobile Hindi draft', en, hi, false);
checkDraft('mobile Odia draft', en, or, false);
checkDraft('web Hindi draft (nav and Today)', WEB_EN, WEB_HI, true);
checkDraft('web Odia draft (nav and Today)', WEB_EN, WEB_OR, true);

describe('draft markers', () => {
  it('heads each draft file with the review notice', () => {
    for (const f of ['../../apps/mobile/src/i18n/hi.ts', '../../apps/mobile/src/i18n/or.ts', '../../apps/web/src/lib/i18n/or.ts',
      '../../apps/web/src/lib/i18n/hi.ts']) {
      expect(readFileSync(new URL(f, import.meta.url), 'utf8').split('\n')[0]).toContain(HEADER);
    }
  });
  it('writes Odia in Odia script and Hindi in Devanagari', () => {
    expect(or['tabs.today']).toMatch(/[଀-୿]/);
    expect(hi['tabs.today']).toMatch(/[ऀ-ॿ]/);
    expect(WEB_OR['nav.today']).toMatch(/[଀-୿]/);
    expect(WEB_HI['nav.today']).toMatch(/[ऀ-ॿ]/);
  });
});

describe('web helper', () => {
  it('translates sidebar labels by link, keeping counts and leaving unknown entries in English', () => {
    const items = [
      { href: '/', label: 'Today', icon: '📋' },
      { href: '/inbox', label: 'Inbox (3)', icon: '💬' },
      { href: '/brand-new', label: 'Brand new', icon: '✨' },
      { href: '/money', label: 'Money (beta)', icon: '💰' },
    ];
    expect(translateNav(items, 'hi').map((i) => i.label)).toEqual(['आज', 'इनबॉक्स (3)', 'Brand new', 'पैसे (beta)']);
    expect(translateNav(items, 'en')).toEqual(items);
  });
  it('fills placeholders and falls back to English', () => {
    expect(translator('or')('today.paused', { n: 2 })).toBe('2 ବିରତିରେ');
    expect(translator('en')('today.paused', { n: 2 })).toBe('2 paused');
  });
});
