'use client';

import { useMemo, useState } from 'react';
import Papa from 'papaparse';
import { readSheet } from 'read-excel-file/browser';
import {
  IMPORT_FIELDS,
  applyMapping,
  guessMapping,
  importChunks,
  importErrorMessage,
  importTemplateRows,
  importWarningMessage,
  istDate,
  previewImportRows,
  type BillingModeValue,
  type ColumnMapping,
  type ImportField,
  type ImportPlan,
  type ImportRow,
} from '@tiffin/core';
import type { ImportResult } from '@tiffin/db';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Alert, Badge, Button, Card, LinkButton, Select } from '@/components/ui';

export type Sheet = { fileName: string; headers: string[]; rows: unknown[][] };

async function readFile(file: File): Promise<Sheet> {
  if (/\.xlsx$/i.test(file.name)) {
    const rows = (await readSheet(file)) as unknown[][];
    return { fileName: file.name, headers: (rows[0] ?? []).map((h) => String(h ?? '')), rows: rows.slice(1) };
  }
  if (/\.xls$/i.test(file.name)) throw new Error('Old .xls files are not supported. Open it in Excel or Google Sheets and save as .xlsx or CSV.');
  const text = await file.text();
  const parsed = Papa.parse<string[]>(text.replace(/^﻿/, ''), { skipEmptyLines: true });
  const rows = parsed.data as unknown[][];
  return { fileName: file.name, headers: (rows[0] ?? []).map((h) => String(h ?? '')), rows: rows.slice(1) };
}

function downloadCsv(name: string, rows: (string | number)[][]) {
  const csv = Papa.unparse(rows);
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

type Totals = Required<Pick<ImportResult, 'imported' | 'failed' | 'errors' | 'warnings' | 'customers' | 'merged'>>;
const EMPTY: Totals = { imported: 0, failed: 0, errors: [], warnings: [], customers: 0, merged: 0 };

/**
 * `initial` hands rows from another source (the notebook-photo import) straight to step 3: they are
 * checked, confirmed and saved through the same import_customers call as an uploaded file.
 * The rows go in chunks (one call each, same batch id); a chunk that fails can be sent again, and
 * the server skips rows it already saved.
 */
export function ImportWizard({ kitchenId, plans, defaultBilling = 'monthly', initial }: {
  kitchenId: string; plans: ImportPlan[]; defaultBilling?: BillingModeValue; initial?: { sheet: Sheet; mapping: ColumnMapping };
}) {
  const [sheet, setSheet] = useState<Sheet | null>(initial?.sheet ?? null);
  const [mapping, setMapping] = useState<ColumnMapping>(initial?.mapping ?? {});
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // A run in progress: its batch id, how many rows are saved so far and the totals (kept for "try again").
  const [run, setRun] = useState<{ batch: string; done: number; totals: Totals } | null>(null);
  const [result, setResult] = useState<{ rows: ImportRow[]; res: Totals } | null>(null);

  const rows = useMemo(() => (sheet ? applyMapping(sheet.rows, mapping) : []), [sheet, mapping]);
  const preview = useMemo(() => previewImportRows(rows, plans, defaultBilling), [rows, plans, defaultBilling]);
  const issues = preview.issues;
  const issueByRow = useMemo(() => new Map(issues.map((i) => [i.row, i.errors])), [issues]);
  const warningByRow = useMemo(() => new Map(preview.warnings.map((w) => [w.row, w])), [preview]);

  async function onFile(file: File | undefined) {
    setError('');
    setResult(null);
    setRun(null);
    if (!file) return;
    try {
      const s = await readFile(file);
      if (s.rows.length > 2000) throw new Error('Import at most 2,000 rows at a time.');
      setSheet(s);
      setMapping(guessMapping(s.headers));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read this file.');
    }
  }

  async function runImport() {
    setBusy(true);
    setError('');
    // Resume a run that stopped part-way (same batch: rows already saved are skipped by the server).
    const current = run ?? { batch: crypto.randomUUID(), done: 0, totals: EMPTY };
    setRun(current);
    let { done, totals } = current;
    for (const chunk of importChunks(rows).filter((c) => c.firstRow > done)) {
      const { data, error } = await supabaseBrowser().rpc('import_customers', {
        p_kitchen: kitchenId,
        p_rows: chunk.rows,
        p_consent: consent,
        p_file_name: sheet?.fileName,
        p_batch: current.batch,
        p_first_row: chunk.firstRow,
        p_total: rows.length,
      });
      if (error) {
        setBusy(false);
        return setError(`${friendlyError(error)} ${done} of ${rows.length} rows were saved. Press Import again to continue.`);
      }
      const res = data as unknown as ImportResult;
      totals = {
        imported: totals.imported + res.imported,
        failed: totals.failed + res.failed,
        errors: [...totals.errors, ...res.errors],
        warnings: [...totals.warnings, ...(res.warnings ?? [])],
        customers: totals.customers + (res.customers ?? res.imported),
        merged: totals.merged + (res.merged ?? 0),
      };
      done = chunk.firstRow + chunk.rows.length - 1;
      setRun({ batch: current.batch, done, totals });
    }
    setBusy(false);
    setRun(null);
    setResult({ rows, res: totals });
  }

  if (result) {
    const { res } = result;
    return (
      <Card title="Import finished">
        <p className="text-sm">
          <strong>{res.customers}</strong> customers saved{res.merged > 0 && <>, <strong>{res.merged}</strong> more plans added from repeated rows</>}.{' '}
          <strong>{res.failed}</strong> rows need fixing.
        </p>
        {res.warnings.length > 0 && (
          <ul className="mt-3 max-h-48 divide-y divide-ink-100 overflow-y-auto text-sm text-amber-800">
            {res.warnings.map((w) => (
              <li key={w.row} className="py-1.5">
                <span className="font-medium">Row {w.row + 1}</span>{' '}
                <span className="text-ink-500">({result.rows[w.row - 1]?.name || 'no name'})</span>: saved. {w.warnings.map(importWarningMessage).join('; ')}
              </li>
            ))}
          </ul>
        )}
        {res.errors.length > 0 && (
          <>
            <ul className="mt-4 max-h-96 divide-y divide-ink-100 overflow-y-auto text-sm">
              {res.errors.map((e) => (
                <li key={e.row} className="py-2">
                  <span className="font-medium">Row {e.row + 1}</span>{' '}
                  <span className="text-ink-500">({result.rows[e.row - 1]?.name || 'no name'})</span>: {e.errors.map(importErrorMessage).join('; ')}
                </li>
              ))}
            </ul>
            <div className="mt-4">
              <Button
                variant="secondary"
                onClick={() =>
                  downloadCsv('rows-to-fix.csv', [
                    ['Row', 'Problem', ...IMPORT_FIELDS.map((f) => f.label)],
                    ...res.errors.map((e) => {
                      const r = result.rows[e.row - 1] ?? {};
                      return [e.row + 1, e.errors.map(importErrorMessage).join('; '), ...IMPORT_FIELDS.map((f) => r[f.key] ?? '')];
                    }),
                  ])
                }
              >
                Download rows to fix (CSV)
              </Button>
            </div>
          </>
        )}
        <div className="mt-6 flex gap-2">
          <LinkButton href="/customers">Go to customers</LinkButton>
          <Button variant="ghost" onClick={() => { setSheet(null); setResult(null); }}>Import another file</Button>
        </div>
      </Card>
    );
  }

  // Rows handed over from the notebook photo: no file to choose and no columns to match.
  const preset = Boolean(initial) && sheet === initial?.sheet;

  return (
    <div className="space-y-6">
      {!preset && <Card title="1. Choose file">
        <input type="file" accept=".xlsx,.xls,.csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} className="text-sm" />
        <p className="mt-2 text-xs text-ink-500">
          First row must be column names. Row numbers below count the header as row 1 (blank rows are skipped).{' '}
          <button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => downloadCsv('customer-template.csv', importTemplateRows(plans, istDate()))}>
            Download template
          </button>
        </p>
        <p className="mt-1 text-xs text-ink-500">
          Status: Active (or blank), Paused (from the &ldquo;Paused from&rdquo; date, or from today) or Stopped (saved with any dues, no plan).
          Lunch and dinner on different plans: use the Second plan column, or repeat the customer on another row with the other plan.
          A blank start date means today.
        </p>
        <div className="mt-2"><Alert>{error}</Alert></div>
      </Card>}
      {preset && <Alert>{error}</Alert>}

      {sheet && !preset && (
        <Card title="2. Match columns">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {IMPORT_FIELDS.map((field) => (
              <label key={field.key} className="block text-sm">
                <span className="font-medium">{field.label}{field.required && ' *'}</span>
                <Select
                  value={mapping[field.key] ?? ''}
                  onChange={(e) => {
                    const next = { ...mapping };
                    if (e.target.value === '') delete next[field.key as ImportField];
                    else next[field.key as ImportField] = Number(e.target.value);
                    setMapping(next);
                    setRun(null); // other rows now: a stopped run starts again as a new batch
                  }}
                >
                  <option value="">— not in file —</option>
                  {sheet.headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                </Select>
              </label>
            ))}
          </div>
        </Card>
      )}

      {sheet && (
        <Card title={`3. Check ${rows.length} rows`} actions={<Badge tone={issues.length ? 'amber' : 'green'}>{issues.length ? `${issues.length} rows need fixing` : 'All rows look good'}</Badge>}>
          <div className="max-h-[28rem] overflow-auto">
            <table className="min-w-full text-sm">
              <thead className="sticky top-0 bg-white text-left text-xs uppercase text-ink-500">
                <tr>
                  <th className="px-2 py-2">Row</th>
                  <th className="px-2 py-2">Name</th>
                  <th className="px-2 py-2">Phone</th>
                  <th className="px-2 py-2">Area</th>
                  <th className="px-2 py-2">Plan</th>
                  <th className="px-2 py-2">Status</th>
                  <th className="px-2 py-2">Problem</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {rows.map((r, i) => {
                  const errs = issueByRow.get(i + 1);
                  const warn = warningByRow.get(i + 1);
                  return (
                    <tr key={i} className={errs ? 'bg-red-50' : warn ? 'bg-amber-50' : ''}>
                      <td className="px-2 py-1.5 text-ink-500">{i + 2}</td>
                      <td className="px-2 py-1.5">{r.name}</td>
                      <td className="px-2 py-1.5">{r.phone}</td>
                      <td className="px-2 py-1.5">{r.area}</td>
                      <td className="px-2 py-1.5">{[r.plan, r.plan_2].filter(Boolean).join(' + ')}</td>
                      <td className="px-2 py-1.5">{r.status || (r.paused_from ? 'Paused' : '')}{r.paused_from ? ` from ${r.paused_from}` : ''}</td>
                      <td className="px-2 py-1.5">
                        {errs && <span className="text-red-700">{errs.map(importErrorMessage).join('; ')}</span>}
                        {!errs && warn && (
                          <span className="text-amber-800">
                            {warn.warnings.map((w) => (w === 'adds_plan' && warn.into ? `Adds this plan to row ${warn.into + 1}` : importWarningMessage(w))).join('; ')}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <label className="mt-4 flex items-start gap-2 text-sm text-ink-700">
            <input type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>These are my existing customers and they agreed to be contacted by my kitchen about their tiffin.</span>
          </label>
          <div className="mt-4 flex items-center gap-3">
            <Button onClick={runImport} disabled={busy || !consent || rows.length === 0 || mapping.name === undefined || mapping.phone === undefined}>
              {busy ? `Saving… ${run?.done ?? 0} of ${rows.length}` : run ? 'Import the rest' : `Import ${rows.length - issues.length} good rows`}
            </Button>
            {issues.length > 0 && <span className="text-xs text-ink-500">Rows with problems are skipped and listed afterwards.</span>}
          </div>
        </Card>
      )}
    </div>
  );
}
