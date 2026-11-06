'use client';

import { useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { downloadText } from '@/lib/money';
import { Button } from '@/components/ui';

type Kind = 'payments' | 'dues' | 'rider_cash';

// CSV files for the accountant or a spreadsheet (built on the server: export_*_csv). Payments and
// rider cash use the dates chosen on the page; dues aging is as of today.
export function CsvExports({ kitchenId, from, to }: { kitchenId: string; from: string; to: string }) {
  const [busy, setBusy] = useState<Kind | null>(null);
  const [error, setError] = useState('');

  async function run(kind: Kind) {
    setBusy(kind);
    setError('');
    const s = supabaseBrowser();
    const { data, error } = kind === 'payments'
      ? await s.rpc('export_payments_csv', { p_kitchen: kitchenId, p_from: from, p_to: to })
      : kind === 'rider_cash'
        ? await s.rpc('export_rider_cash_csv', { p_kitchen: kitchenId, p_from: from, p_to: to })
        : await s.rpc('export_dues_aging_csv', { p_kitchen: kitchenId });
    setBusy(null);
    if (error) {
      return setError(error.message === 'range_too_long' ? 'Choose a range of up to one year.' : friendlyError(error));
    }
    const name = kind === 'dues' ? `dues-aging-${to}.csv` : `${kind === 'payments' ? 'payments' : 'rider-cash'}-${from}-to-${to}.csv`;
    downloadText(name, String(data ?? ''));
  }

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="csv-exports">
      <span className="text-sm text-ink-600">Download CSV:</span>
      <Button variant="secondary" className="px-3 py-1" disabled={busy !== null} onClick={() => run('payments')}>{busy === 'payments' ? 'Preparing…' : 'Payments'}</Button>
      <Button variant="secondary" className="px-3 py-1" disabled={busy !== null} onClick={() => run('dues')}>{busy === 'dues' ? 'Preparing…' : 'Dues aging'}</Button>
      <Button variant="secondary" className="px-3 py-1" disabled={busy !== null} onClick={() => run('rider_cash')}>{busy === 'rider_cash' ? 'Preparing…' : 'Rider cash'}</Button>
      {error && <span className="text-sm text-red-700">{error}</span>}
    </div>
  );
}
