// The WhatsApp template pack (D-134): templates.ts, docs/WHATSAPP_TEMPLATES.md and
// docs/whatsapp-templates.csv stay in sync. Run with UPDATE_TEMPLATE_PACK=1 to rewrite the CSV.
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TEMPLATES } from '../../supabase/functions/_shared/templates.ts';
import { EXTERNAL_TEMPLATES, packCsv, placeholders, TEMPLATE_SAMPLES, templatePack } from '../../supabase/functions/_shared/template-pack.ts';

const root = new URL('../../', import.meta.url);
const doc = readFileSync(new URL('docs/WHATSAPP_TEMPLATES.md', root), 'utf8');
const csvPath = new URL('docs/whatsapp-templates.csv', root);

describe('WhatsApp template pack', () => {
  it('every template has a sample and renders every variable', () => {
    expect(Object.keys(TEMPLATE_SAMPLES).sort()).toEqual(Object.keys(TEMPLATES).sort());
    for (const row of templatePack()) {
      expect(row.examples.every((e) => String(e).trim() !== ''), `${row.name} ${row.language}`).toBe(true);
      expect(placeholders(row.body), `${row.name} ${row.language}`).toEqual(row.examples.map((_, i) => i + 1));
    }
  });

  it('template names are valid for Meta and unique per language', () => {
    const rows = templatePack();
    for (const r of rows) expect(r.name).toMatch(/^[a-z0-9_]{1,512}$/);
    const keys = rows.map((r) => `${r.name}/${r.language}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('docs/WHATSAPP_TEMPLATES.md lists every template with its category and exact English body', () => {
    for (const def of Object.values(TEMPLATES)) {
      const line = doc.split('\n').find((l) => l.startsWith(`| \`${def.name}\` |`));
      expect(line, def.name).toBeDefined();
      expect(line!.toLowerCase(), def.name).toContain(`| ${def.category.toLowerCase()} |`);
      expect(line, def.name).toContain(`\`${def.text.en}\``);
    }
    for (const t of EXTERNAL_TEMPLATES) expect(doc).toContain(`\`${t.name}\``);
  });

  it('docs/whatsapp-templates.csv is the generated pack', () => {
    const csv = packCsv();
    if (process.env.UPDATE_TEMPLATE_PACK === '1') writeFileSync(csvPath, csv);
    expect(readFileSync(csvPath, 'utf8')).toBe(csv);
  });
});
