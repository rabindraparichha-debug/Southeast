'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { SLOT_LABEL, formatPaise, formatServiceDate } from '@tiffin/core';
import type { SyncReject } from '@tiffin/db';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError, friendlyErrorIn } from '@/lib/errors';
import { formatIstDateTime } from '@/lib/delivery';
import { Alert, Badge, Button, Card, Input } from '@/components/ui';

const ACTION: Record<string, string> = { start: 'Start run', complete: 'Delivered', fail: 'Not delivered', finish: 'Finish run' };

// Rider actions the server refused (rider_sync_rejects, D-128). The phone keeps them in its "needs
// attention" list; this is the owner's copy, so cash collected at the door is never lost silently.
// Owner only. Shown only while something is open.
export function SyncRejectsCard({ rows }: { rows: SyncReject[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  if (!rows.length) return null;

  const resolve = async (id: string) => {
    setBusy(id);
    setError('');
    const { error: e } = await supabaseBrowser().rpc('resolve_sync_reject', { p_id: id, p_note: notes[id]?.trim() || undefined });
    setBusy(null);
    if (e) return setError(friendlyError(e));
    router.refresh();
  };

  return (
    <Card title={`Refused on a rider's phone (${rows.length})`} className="mb-6 ring-amber-200">
      <p className="mb-3 text-sm text-ink-600">
        The server did not accept these rider actions. The rider still has them on the phone. Check with the rider,
        especially any cash, then mark each one handled.
      </p>
      {error && <Alert>{error}</Alert>}
      <ul className="divide-y divide-ink-100" data-testid="sync-rejects">
        {rows.map((r) => {
          const summary = (r.summary ?? {}) as { note?: string; reason?: string; proof?: string };
          const where = [r.customer_name, r.route_name, r.service_date ? formatServiceDate(r.service_date) : null, r.slot ? SLOT_LABEL[r.slot] : null]
            .filter(Boolean).join(' · ');
          return (
            <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
              <div className="min-w-0 space-y-0.5 text-sm">
                <p className="font-medium text-ink-900">
                  {ACTION[r.action] ?? r.action}{where ? `: ${where}` : ''}
                  {r.cash_paise > 0 && <span className="ml-2"><Badge tone="amber">Cash {formatPaise(r.cash_paise)}</Badge></span>}
                  {r.had_photo && <span className="ml-2"><Badge>Photo on phone</Badge></span>}
                </p>
                <p className="text-ink-700">{friendlyErrorIn('sync_reject', { message: r.error_code })}</p>
                {summary.note && <p className="text-ink-500">Rider’s note: {summary.note}</p>}
                <p className="text-xs text-ink-500">
                  {r.rider_name ?? 'Rider'} · tapped {formatIstDateTime(r.acted_at)}{r.reports > 1 ? ` · refused ${r.reports} times` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  aria-label="Note (optional)" placeholder="Note (optional)" className="w-40"
                  value={notes[r.id] ?? ''} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} maxLength={500}
                />
                <Button variant="secondary" disabled={busy === r.id} onClick={() => void resolve(r.id)}>Mark handled</Button>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
