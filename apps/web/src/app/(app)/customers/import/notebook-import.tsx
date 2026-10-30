'use client';

import { useRef, useState } from 'react';
import type { ColumnMapping } from '@tiffin/core';
import { istDate } from '@tiffin/core';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { downscaleJpeg } from '@/lib/image';
import { uuid } from '@/lib/rider-store';
import { Alert, Badge, Button, Card, Input, Select } from '@/components/ui';
import type { Sheet } from './import-wizard';

// What the notebook-import Edge Function returns (supabase/functions/_shared/notebook.ts).
type Flag = 'missing_name' | 'missing_phone' | 'invalid_phone' | 'duplicate_phone' | 'unknown_plan' | 'low_confidence' | 'check_balance' | 'invalid_meals_left';
type PreviewRow = {
  row: number; name: string | null; phone: string | null; phone_raw: string | null; line1: string | null; area: string | null;
  plan: string | null; plan_raw: string | null; suggested_balance_meals: number | null; notes: string | null; confidence: number | null;
  flags: Flag[]; importable: boolean;
};
type Preview = { mode: string; rows: PreviewRow[]; summary: { total: number; importable: number; flagged: number } };

const FLAG_LABEL: Record<Flag, string> = {
  missing_name: 'Name not readable',
  missing_phone: 'No phone',
  invalid_phone: 'Phone looks wrong',
  duplicate_phone: 'Phone appears twice',
  unknown_plan: 'Plan not matched',
  low_confidence: 'Hard to read: check',
  check_balance: 'Meals left noted',
  invalid_meals_left: 'Meals left unreadable',
};

type Row = { key: string; name: string; phone: string; line1: string; area: string; plan: string; notes: string; balance: string; suggested: number | null; planRaw: string | null; flags: Flag[]; confidence: number | null };

const HEADERS = ['Name', 'Phone', 'Flat / house', 'Area', 'Plan', 'Notes', 'Opening balance (meals)'];
const MAPPING: ColumnMapping = { name: 0, phone: 1, line1: 2, area: 3, plan: 4, notes: 5, balance: 6 };

async function functionError(error: unknown): Promise<string> {
  const ctx = (error as { context?: Response })?.context;
  if (ctx && typeof ctx.json === 'function') {
    try {
      const body = (await ctx.json()) as { error?: string };
      if (body?.error) return body.error;
    } catch {
      // not JSON
    }
  }
  return (error as { message?: string })?.message ?? 'ai_error';
}

/**
 * Notebook photo → rows the owner checks and corrects → the existing import flow. The photo goes to
 * the private 'imports' bucket; the Edge Function only reads it and returns a preview. No customer is
 * saved until the owner confirms in the import step.
 */
export function NotebookImport({ kitchenId, planNames, onConfirm }: {
  kitchenId: string; planNames: string[]; onConfirm: (initial: { sheet: Sheet; mapping: ColumnMapping }) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<'idle' | 'uploading' | 'reading' | 'review'>('idle');
  const [rows, setRows] = useState<Row[]>([]);
  const [mode, setMode] = useState('');
  const [error, setError] = useState('');

  async function onFile(file: File | undefined) {
    if (input.current) input.current.value = '';
    if (!file) return;
    setError('');
    try {
      setStage('uploading');
      const jpeg = await downscaleJpeg(file, 2200, 0.82); // big enough to keep handwriting readable, under the 5 MB limit
      const path = `${kitchenId}/${istDate()}-${uuid().slice(0, 8)}.jpg`;
      const supabase = supabaseBrowser();
      const up = await supabase.storage.from('imports').upload(path, jpeg, { contentType: 'image/jpeg' });
      if (up.error) throw up.error;
      setStage('reading');
      const { data, error: fnError } = await supabase.functions.invoke('notebook-import', { body: { kitchen_id: kitchenId, path } });
      if (fnError) throw new Error(await functionError(fnError));
      const preview = data as Preview;
      setMode(preview.mode);
      setRows(preview.rows.map((r) => ({
        key: `${r.row}`, name: r.name ?? '', phone: r.phone ? r.phone.replace(/^\+91/, '') : r.phone_raw ?? '',
        line1: r.line1 ?? '', area: r.area ?? '', plan: r.plan ?? '', notes: r.notes ?? '', balance: '',
        suggested: r.suggested_balance_meals, planRaw: r.plan_raw, flags: r.flags, confidence: r.confidence,
      })));
      setStage('review');
    } catch (e) {
      const m = (e as { message?: string }).message ?? '';
      setError(m === 'invalid_photo' ? friendlyError({ message: 'photo_failed' }) : friendlyError({ message: m }));
      setStage('idle');
    }
  }

  const update = (key: string, patch: Partial<Row>) => setRows(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  function confirm() {
    onConfirm({
      sheet: {
        fileName: `Notebook photo ${istDate()}`,
        headers: HEADERS,
        rows: rows.map((r) => [r.name.trim(), r.phone.trim(), r.line1.trim(), r.area.trim(), r.plan, r.notes.trim(), r.balance.trim()]),
      },
      mapping: MAPPING,
    });
  }

  if (stage !== 'review') {
    return (
      <Card title="Import from a notebook photo">
        <p className="text-sm text-ink-600">Take a clear photo of one page of your customer notebook. We read the names, phones, flats and plans; you check every row before anything is saved.</p>
        <input ref={input} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} data-testid="notebook-input" />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button variant="secondary" onClick={() => input.current?.click()} disabled={stage !== 'idle'} data-testid="notebook-button">
            {stage === 'uploading' ? 'Uploading…' : stage === 'reading' ? 'Reading the page…' : '📷 Photo of notebook page'}
          </Button>
          <span className="text-xs text-ink-500">Flat on a table, good light, whole page in the frame.</span>
        </div>
        {error && <div className="mt-2"><Alert>{error}</Alert></div>}
      </Card>
    );
  }

  const ready = rows.filter((r) => r.name.trim() && r.phone.trim()).length;
  return (
    <Card title={`Check what we read (${rows.length} rows)`}
      actions={<Button variant="ghost" onClick={() => { setRows([]); setStage('idle'); }}>Start over</Button>}>
      {mode === 'mock' && <div className="mb-3"><Alert tone="amber">Demo mode: sample rows (no AI key set on the server).</Alert></div>}
      <p className="mb-3 text-sm text-ink-600">Fix anything that looks wrong and remove rows you don’t want. Rows marked in amber need a closer look. Nothing is saved yet.</p>
      <ul className="space-y-3" data-testid="notebook-rows">
        {rows.map((r) => {
          const warn = r.flags.some((f) => f !== 'check_balance');
          return (
            <li key={r.key} className={`rounded-lg p-3 ring-1 ${warn ? 'bg-amber-50 ring-amber-200' : 'bg-white ring-ink-100'}`} data-testid="notebook-row">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap gap-1">
                  <span className="text-xs text-ink-500">Row {r.key}</span>
                  {r.flags.filter((f) => f !== 'check_balance').map((f) => <Badge key={f} tone={f === 'low_confidence' ? 'amber' : 'red'}>{FLAG_LABEL[f]}</Badge>)}
                  {r.confidence != null && <span className="text-xs text-ink-500">{Math.round(r.confidence * 100)}% sure</span>}
                </div>
                <Button variant="ghost" className="text-red-700" onClick={() => setRows(rows.filter((x) => x.key !== r.key))}>Remove</Button>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Input aria-label="Name" placeholder="Name" value={r.name} onChange={(e) => update(r.key, { name: e.target.value })} />
                <Input aria-label="Phone" placeholder="Phone" inputMode="tel" value={r.phone} onChange={(e) => update(r.key, { phone: e.target.value })} />
                <Input aria-label="Flat / house" placeholder="Flat / house" value={r.line1} onChange={(e) => update(r.key, { line1: e.target.value })} />
                <Input aria-label="Area" placeholder="Area" value={r.area} onChange={(e) => update(r.key, { area: e.target.value })} />
                <Select aria-label="Plan" value={r.plan} onChange={(e) => update(r.key, { plan: e.target.value })}>
                  <option value="">{r.planRaw ? `No plan (notebook says “${r.planRaw}”)` : 'No plan'}</option>
                  {planNames.map((p) => <option key={p} value={p}>{p}</option>)}
                </Select>
                <Input aria-label="Notes" placeholder="Notes" value={r.notes} onChange={(e) => update(r.key, { notes: e.target.value })} />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                <label className="flex items-center gap-2">
                  <span className="text-ink-700">Opening balance (meals)</span>
                  <Input aria-label="Opening balance (meals)" className="w-20" inputMode="numeric" value={r.balance} onChange={(e) => update(r.key, { balance: e.target.value.replace(/[^\d-]/g, '') })} />
                </label>
                {r.suggested != null && r.balance !== String(r.suggested) && (
                  <button type="button" className="text-xs font-medium text-brand-700 underline" onClick={() => update(r.key, { balance: String(r.suggested) })}>
                    Notebook says {r.suggested}: use it
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button onClick={confirm} disabled={!ready} data-testid="notebook-continue">Continue with {rows.length} row{rows.length === 1 ? '' : 's'}</Button>
        <span className="text-xs text-ink-500">Next you confirm consent and import. Rows with problems are skipped and listed.</span>
      </div>
    </Card>
  );
}
