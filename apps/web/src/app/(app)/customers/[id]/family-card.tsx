'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Alert, Badge, Button, Card, Field, Select } from '@/components/ui';

type Option = { id: string; name: string };

// Parent pays, student eats (P5) and office plans (P6). Owner only: who pays is a money matter.
// Balances stay with the eater; the payer gets the money messages and pays from their own page.
export function FamilyCard({ customerId, payer, dependents, candidates, office, offices }: {
  customerId: string;
  payer: Option | null;
  dependents: Option[];
  candidates: Option[];
  office: Option | null;
  offices: Option[];
}) {
  const router = useRouter();
  const [payerId, setPayerId] = useState(payer?.id ?? '');
  const [officeId, setOfficeId] = useState(office?.id ?? '');
  const [msg, setMsg] = useState<{ tone: 'red' | 'green'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function savePayer() {
    setBusy(true);
    setMsg(null);
    const { error } = await supabaseBrowser().rpc('set_payer', payerId ? { p_customer: customerId, p_payer: payerId } : { p_customer: customerId });
    setBusy(false);
    if (error) return setMsg({ tone: 'red', text: friendlyError(error) });
    setMsg({ tone: 'green', text: payerId ? 'Payer saved. Money messages now go to them.' : 'Payer removed.' });
    router.refresh();
  }

  async function saveOffice() {
    setBusy(true);
    setMsg(null);
    const { error } = await supabaseBrowser().rpc('set_customer_office', officeId ? { p_customer: customerId, p_office: officeId } : { p_customer: customerId });
    setBusy(false);
    if (error) return setMsg({ tone: 'red', text: friendlyError(error) });
    setMsg({ tone: 'green', text: officeId ? 'Added to the office. Their meals go to the office stop.' : 'Removed from the office.' });
    router.refresh();
  }

  const paysForOthers = dependents.length > 0;

  return (
    <Card title="Who pays" actions={payer ? <Badge tone="blue">Paid by {payer.name}</Badge> : null}>
      <div className="space-y-4">
        {paysForOthers ? (
          <div className="text-sm">
            <p className="font-medium text-ink-800">Pays for</p>
            <ul className="mt-1 space-y-1">
              {dependents.map((d) => (
                <li key={d.id}><Link href={`/customers/${d.id}`} className="text-brand-700 hover:underline">{d.name}</Link></li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-ink-500">Someone who pays for others can’t have a payer themselves.</p>
          </div>
        ) : (
          <div className="space-y-2">
            <Field label="Payer (parent, guardian…)" hint="Low-balance and payment messages go to the payer, who can pay from their page. The meal balance stays with this customer.">
              <Select value={payerId} onChange={(e) => setPayerId(e.target.value)} data-testid="payer-select">
                <option value="">Pays for themselves</option>
                {candidates.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
            <Button variant="secondary" onClick={savePayer} disabled={busy || payerId === (payer?.id ?? '')} data-testid="save-payer">Save payer</Button>
          </div>
        )}

        <div className="space-y-2 border-t border-ink-100 pt-4">
          <Field label="Office" hint={offices.length ? 'Office members get one shared delivery stop; the office’s billing contact becomes their payer.' : undefined}>
            <Select value={officeId} onChange={(e) => setOfficeId(e.target.value)} disabled={!offices.length && !office}>
              <option value="">Not in an office</option>
              {offices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </Select>
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" onClick={saveOffice} disabled={busy || officeId === (office?.id ?? '')}>Save office</Button>
            <Link href="/customers/offices" className="text-sm text-brand-700 hover:underline">{offices.length ? 'Manage offices' : 'Set up an office'}</Link>
          </div>
        </div>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      </div>
    </Card>
  );
}
