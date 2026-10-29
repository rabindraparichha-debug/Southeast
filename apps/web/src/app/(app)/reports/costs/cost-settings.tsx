'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { rupeesToPaise } from '@tiffin/core';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Alert, Button, Card, Field, Input } from '@/components/ui';

type Initial = { gas: number; packaging: number; variancePct: number; priceJumpPct: number };

/** Owner-updatable kitchen_settings columns used by inventory and the cost report. */
export function CostSettings({ kitchenId, initial }: { kitchenId: string; initial: Initial }) {
  const router = useRouter();
  const [f, setF] = useState({
    gas: String(initial.gas / 100), packaging: String(initial.packaging / 100),
    variancePct: String(initial.variancePct), priceJumpPct: String(initial.priceJumpPct),
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'red' | 'green'; text: string } | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    const gas = rupeesToPaise(f.gas || '0');
    const packaging = rupeesToPaise(f.packaging || '0');
    const variance = Number(f.variancePct);
    const jump = Number(f.priceJumpPct);
    if (gas === null || packaging === null || gas > 10000 || packaging > 10000) return setMsg({ tone: 'red', text: 'Gas and packaging: ₹0 to ₹100 per meal.' });
    if (!Number.isFinite(variance) || variance < 0 || variance > 100) return setMsg({ tone: 'red', text: 'Stock-take difference: 0 to 100%.' });
    if (!Number.isFinite(jump) || jump < 1 || jump > 500) return setMsg({ tone: 'red', text: 'Price jump alert: 1 to 500%.' });
    setBusy(true);
    const { error } = await supabaseBrowser().from('kitchen_settings').update({
      gas_paise_per_meal: gas, packaging_paise_per_meal: packaging, variance_reason_pct: variance, price_jump_pct: jump,
    }).eq('kitchen_id', kitchenId);
    setBusy(false);
    if (error) return setMsg({ tone: 'red', text: friendlyError(error) });
    setMsg({ tone: 'green', text: 'Saved. The report uses the new gas and packaging costs.' });
    router.refresh();
  }

  return (
    <Card title="Cost settings">
      <form onSubmit={save} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="Cost settings">
        <Field label="Gas per meal (₹)" hint="Cylinder price ÷ meals per cylinder.">
          <Input value={f.gas} onChange={(e) => setF({ ...f, gas: e.target.value })} inputMode="decimal" aria-label="Gas per meal" />
        </Field>
        <Field label="Packaging per meal (₹)" hint="Containers, bags, foil.">
          <Input value={f.packaging} onChange={(e) => setF({ ...f, packaging: e.target.value })} inputMode="decimal" aria-label="Packaging per meal" />
        </Field>
        <Field label="Stock-take reason above (%)" hint="Count differences bigger than this need a reason.">
          <Input value={f.variancePct} onChange={(e) => setF({ ...f, variancePct: e.target.value })} inputMode="decimal" aria-label="Variance reason percent" />
        </Field>
        <Field label="Price jump alert above (%)" hint="Warn when a bill price rises more than this.">
          <Input value={f.priceJumpPct} onChange={(e) => setF({ ...f, priceJumpPct: e.target.value })} inputMode="decimal" aria-label="Price jump percent" />
        </Field>
        <div className="flex items-center gap-3 sm:col-span-2 lg:col-span-4">
          <Button disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</Button>
          {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        </div>
      </form>
    </Card>
  );
}
