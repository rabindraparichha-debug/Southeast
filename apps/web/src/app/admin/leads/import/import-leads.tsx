'use client';

import { useState } from 'react';
import Papa from 'papaparse';
import { normalizePhone } from '@tiffin/core';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { SOURCE_LABEL, type LeadSource } from '@/lib/public';
import { Alert, Button, Card, Field, Select } from '@/components/ui';

const SOURCES: LeadSource[] = ['sulekha', 'justdial', 'google_ads', 'instagram', 'website', 'referral', 'other'];
const MAX_ROWS = 2000;

type Row = { external_id?: string; name?: string; phone?: string; area?: string; campaign?: string; slots?: string[]; diet?: string; notes?: string };
type Result = { created: number; duplicates: number; errors: { row: number; error: string }[] };

// Column names vary by directory; map the common ones.
const COLUMNS: Record<keyof Row, RegExp> = {
  external_id: /^(external[ _]?id|lead[ _]?id|enquiry[ _]?id|id)$/i,
  name: /^(name|customer[ _]?name|buyer[ _]?name|contact[ _]?person)$/i,
  phone: /^(phone|mobile|mobile[ _]?(no|number)|phone[ _]?(no|number)|contact[ _]?(no|number))$/i,
  area: /^(area|locality|location|address)$/i,
  campaign: /^(campaign)$/i,
  slots: /^(slots|meals?|meal[ _]?times?)$/i,
  diet: /^(diet|food[ _]?type)$/i,
  notes: /^(notes?|requirement|details|message)$/i,
};

function toRow(raw: Record<string, string>): Row {
  const row: Row = {};
  for (const [header, value] of Object.entries(raw)) {
    const v = value?.trim();
    if (!v) continue;
    const key = (Object.keys(COLUMNS) as (keyof Row)[]).find((k) => COLUMNS[k].test(header.trim()));
    if (!key || row[key]) continue;
    if (key === 'slots') {
      const s = v.toLowerCase();
      const slots = [/lunch|both/.test(s) && 'lunch', /dinner|both/.test(s) && 'dinner'].filter(Boolean) as string[];
      if (slots.length) row.slots = slots;
    } else if (key === 'diet') {
      const s = v.toLowerCase();
      const diet = /jain/.test(s) ? 'jain' : /non/.test(s) ? 'nonveg' : /veg/.test(s) ? 'veg' : undefined;
      if (diet) row.diet = diet;
    } else {
      row[key] = v.slice(0, 300);
    }
  }
  return row;
}

export function ImportLeads() {
  const [source, setSource] = useState<LeadSource>('sulekha');
  const [rows, setRows] = useState<Row[]>([]);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  function onFile(file: File | undefined) {
    setError('');
    setResult(null);
    setRows([]);
    if (!file) return;
    setFileName(file.name);
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const parsed = res.data.map(toRow).filter((r) => r.phone || r.name);
        if (!parsed.length) return setError('No rows with a name or phone column were found.');
        if (parsed.length > MAX_ROWS) return setError(`Up to ${MAX_ROWS} rows per file; this one has ${parsed.length}. Split it.`);
        setRows(parsed);
      },
      error: () => setError('Could not read this file. Save it as CSV (UTF-8) and try again.'),
    });
  }

  async function upload() {
    setBusy(true);
    setError('');
    const { data, error: err } = await supabaseBrowser().rpc('admin_import_leads', { p_source: source, p_rows: rows });
    setBusy(false);
    if (err) return setError(friendlyError(err));
    setResult(data as unknown as Result);
  }

  const badPhones = rows.filter((r) => !normalizePhone(r.phone ?? '')).length;

  return (
    <div className="space-y-4">
      <Card className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Source">
            <Select value={source} onChange={(e) => setSource(e.target.value as LeadSource)}>
              {SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
            </Select>
          </Field>
          <Field label="CSV file" hint="Columns: name, phone, area, slots, diet, notes (optional external_id).">
            <input type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])}
              className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:text-brand-700" />
          </Field>
        </div>
        {error && <Alert>{error}</Alert>}
        {rows.length > 0 && !result && (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-ink-700">
              {fileName}: {rows.length} rows{badPhones ? `, ${badPhones} without a valid mobile number (they will be listed and skipped)` : ''}.
            </p>
            <Button onClick={upload} disabled={busy}>{busy ? 'Importing…' : `Import ${rows.length} leads`}</Button>
          </div>
        )}
      </Card>

      {rows.length > 0 && !result && (
        <Card className="overflow-x-auto p-0">
          <table className="min-w-full text-sm">
            <thead className="border-b border-ink-100 text-left text-xs uppercase text-ink-500">
              <tr><th className="px-4 py-2">Name</th><th className="px-4 py-2">Phone</th><th className="px-4 py-2">Area</th><th className="px-4 py-2">Wants</th></tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {rows.slice(0, 20).map((r, i) => (
                <tr key={i} className={normalizePhone(r.phone ?? '') ? '' : 'bg-red-50'}>
                  <td className="px-4 py-2">{r.name ?? '—'}</td>
                  <td className="px-4 py-2">{r.phone ? `•••••${r.phone.replace(/\D/g, '').slice(-4)}` : '—'}</td>
                  <td className="px-4 py-2">{r.area ?? '—'}</td>
                  <td className="px-4 py-2 text-ink-500">{[r.slots?.join('+'), r.diet].filter(Boolean).join(' · ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 20 && <p className="px-4 py-2 text-xs text-ink-500">Showing 20 of {rows.length}.</p>}
        </Card>
      )}

      {result && (
        <Card className="space-y-2">
          <p className="text-sm font-medium text-ink-900">
            {result.created} new · {result.duplicates} already imported · {result.errors.length} skipped
          </p>
          {result.errors.length > 0 && (
            <ul className="list-disc pl-5 text-sm text-ink-700">
              {result.errors.slice(0, 50).map((e) => <li key={e.row}>Row {e.row}: {friendlyError({ message: e.error })}</li>)}
            </ul>
          )}
          <p className="text-sm text-ink-500">New leads get the WhatsApp qualification flow only if they opted in; otherwise call them from Leads.</p>
        </Card>
      )}
    </div>
  );
}
