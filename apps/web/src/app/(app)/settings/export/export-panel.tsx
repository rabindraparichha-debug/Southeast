'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ExportPage, ExportPart } from '@tiffin/db';
import { exportRow, istDate, toCsvText, zipFiles } from '@tiffin/core';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Alert, Button, Card, Textarea } from '@/components/ui';

const PARTS: { part: ExportPart; label: string }[] = [
  { part: 'customers', label: 'Customers (with full phone numbers)' },
  { part: 'subscriptions', label: 'Subscriptions' },
  { part: 'payments', label: 'Payments' },
  { part: 'balance_entries', label: 'Balance entries (meals, recharges, credits)' },
  { part: 'meal_orders', label: 'Meals of the last 12 months' },
];

/** "Export my kitchen": every part page by page, then one ZIP of CSV files, built in the browser. */
export function ExportPanel({ kitchenId, kitchenSlug }: { kitchenId: string; kitchenSlug: string }) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');

  async function run() {
    setBusy(true);
    setError('');
    const supabase = supabaseBrowser();
    const files: { name: string; data: string }[] = [];
    try {
      for (const { part, label } of PARTS) {
        const rows: Record<string, unknown>[] = [];
        let offset: number | null = 0;
        while (offset !== null) {
          setProgress(`${label}: ${rows.length} rows…`);
          const { data, error }: { data: unknown; error: { message: string } | null } =
            await supabase.rpc('export_kitchen', { p_kitchen: kitchenId, p_part: part, p_offset: offset, p_limit: 2000 });
          if (error) throw error;
          const page = data as ExportPage;
          rows.push(...page.rows.map((r) => exportRow(r as Record<string, never>)));
          offset = page.next_offset;
        }
        files.push({ name: `${part}.csv`, data: toCsvText(rows as Record<string, never>[]) });
      }
      const zip = zipFiles(files);
      const url = URL.createObjectURL(new Blob([zip.buffer as ArrayBuffer], { type: 'application/zip' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${kitchenSlug}-export-${istDate()}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setProgress('Downloaded. Keep the file safe: it has your customers’ phone numbers.');
    } catch (e) {
      setProgress('');
      setError(friendlyError(e as { message?: string }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Export my kitchen">
      <p className="text-sm text-ink-600">
        One ZIP file with a spreadsheet (CSV) for each of these. It opens in Excel or Google Sheets. Downloading customer
        phone numbers is recorded in your kitchen’s log.
      </p>
      <ul className="mt-2 list-inside list-disc text-sm text-ink-700">
        {PARTS.map((p) => <li key={p.part}>{p.label}</li>)}
      </ul>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button onClick={run} disabled={busy}>{busy ? 'Preparing…' : 'Download ZIP'}</Button>
        {progress && <span className="text-sm text-ink-500">{progress}</span>}
      </div>
      {error && <div className="mt-3"><Alert>{error}</Alert></div>}
    </Card>
  );
}

/** "Request to close my kitchen": files a request the Tiffin team handles by hand (nothing is deleted). */
export function CloseRequest({ kitchenId, open }: { kitchenId: string; open: { created_at: string; reason: string | null } | null }) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function call(fn: 'request_kitchen_close' | 'withdraw_kitchen_close') {
    if (fn === 'request_kitchen_close' && !window.confirm('Ask the Tiffin team to close this kitchen? Your kitchen keeps running until they call you.')) return;
    setBusy(true);
    setError('');
    const supabase = supabaseBrowser();
    const { error } = fn === 'request_kitchen_close'
      ? await supabase.rpc('request_kitchen_close', { p_kitchen: kitchenId, p_reason: reason.trim() || undefined })
      : await supabase.rpc('withdraw_kitchen_close', { p_kitchen: kitchenId });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    setReason('');
    router.refresh();
  }

  return (
    <Card title="Close my kitchen">
      {open ? (
        <div className="space-y-3 text-sm">
          <Alert tone="amber">
            You asked to close this kitchen on {new Date(open.created_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' })}.
            The Tiffin team will call you. Nothing changes until then.
          </Alert>
          <Button variant="secondary" disabled={busy} onClick={() => call('withdraw_kitchen_close')}>Withdraw the request</Button>
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <p className="text-ink-600">
            Download your export first. The Tiffin team then calls you, stops the kitchen and removes personal data the law
            lets us remove. Money records are kept as the law requires.
          </p>
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} placeholder="Why are you leaving? (optional)" aria-label="Reason" />
          <Button variant="danger" disabled={busy} onClick={() => call('request_kitchen_close')}>Request to close my kitchen</Button>
        </div>
      )}
      {error && <div className="mt-3"><Alert>{error}</Alert></div>}
    </Card>
  );
}
