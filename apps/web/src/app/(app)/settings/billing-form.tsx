'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { BillingMode } from '@tiffin/db';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Alert, Button, Card } from '@/components/ui';

const OPTIONS: { value: BillingMode; title: string; text: string }[] = [
  {
    value: 'monthly',
    title: 'Monthly (pay later)',
    text: 'Meals go on the customer’s khata at their own price. You collect at month end with a statement. Nothing stops automatically.',
  },
  {
    value: 'prepaid',
    title: 'Prepaid (pay in advance)',
    text: 'Customers buy meals first. Low balance alerts, and meals stop at your credit limit (see the balance rules below).',
  },
];

// D-115: the kitchen's default billing for new customers (each customer can still be switched).
export function BillingForm({ kitchenId, initial }: { kitchenId: string; initial: BillingMode }) {
  const router = useRouter();
  const [mode, setMode] = useState<BillingMode>(initial);
  const [msg, setMsg] = useState<{ tone: 'red' | 'green'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setMsg(null);
    const { error } = await supabaseBrowser().from('kitchen_settings').update({ default_billing_mode: mode }).eq('kitchen_id', kitchenId);
    setBusy(false);
    if (error) return setMsg({ tone: 'red', text: friendlyError(error) });
    setMsg({ tone: 'green', text: 'Saved. New customers start with this billing.' });
    router.refresh();
  }

  return (
    <Card title="Billing for new customers" className="mb-6">
      <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Billing for new customers">
        {OPTIONS.map((o) => (
          <label key={o.value}
            className={`flex cursor-pointer items-start gap-3 rounded-lg p-3 text-sm ring-1 ${mode === o.value ? 'bg-brand-50 ring-brand-500' : 'ring-ink-200'}`}>
            <input type="radio" name="default_billing_mode" className="mt-1" checked={mode === o.value} onChange={() => setMode(o.value)} />
            <span>
              <span className="block font-medium text-ink-900">{o.title}</span>
              <span className="text-ink-600">{o.text}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="mt-3 text-xs text-ink-500">Existing customers keep their billing. Change one customer from their Money card.</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button onClick={save} disabled={busy || mode === initial}>{busy ? 'Saving…' : 'Save billing'}</Button>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      </div>
    </Card>
  );
}
