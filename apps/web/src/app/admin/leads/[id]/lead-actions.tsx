'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { formatPaise } from '@tiffin/core';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyErrorIn } from '@/lib/errors';
import type { LeadChoice, LeadStatus } from '@/lib/public';
import { Alert, Button, Field, Input, Select } from '@/components/ui';
import type { NearbyKitchen } from '../types';

export function LeadActions({ leadId, status, placed, kitchens }: { leadId: string; status: LeadStatus; placed: boolean; kitchens: NearbyKitchen[] }) {
  const router = useRouter();
  const supabase = supabaseBrowser();
  const [kitchen, setKitchen] = useState(kitchens[0]?.kitchen_id ?? '');
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ tone: 'red' | 'green'; text: string } | null>(null);
  const [assigned, setAssigned] = useState<LeadChoice | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>, ok: string) {
    setBusy(true);
    setMsg(null);
    const { data, error } = await fn();
    setBusy(false);
    if (error) {
      setMsg({ tone: 'red', text: friendlyErrorIn('admin', error) });
      return null;
    }
    setMsg({ tone: 'green', text: ok });
    router.refresh();
    return data ?? true;
  }

  async function assign() {
    if (!kitchen) return;
    const name = kitchens.find((k) => k.kitchen_id === kitchen)?.name;
    if (!window.confirm(`Make this lead a customer of ${name} with a trial subscription?`)) return;
    const data = await run(() => supabase.rpc('admin_assign_lead', { p_lead: leadId, p_kitchen: kitchen }), `Placed with ${name}. The owner has been told.`);
    if (data && typeof data === 'object') setAssigned(data as LeadChoice);
  }

  const done = placed || ['trial', 'converted', 'renewed'].includes(status);

  return (
    <div className="space-y-5 text-sm">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {assigned && (
        <div className="rounded-lg bg-green-50 p-3 ring-1 ring-green-200">
          <p>{assigned.kitchen_name} · {assigned.plan_name} · trial {assigned.trial_meals} meals = {formatPaise(assigned.trial_amount_paise)}</p>
          <Link href={`/c/${assigned.portal_token}`} target="_blank" className="text-brand-700 underline">Customer page link</Link>
          <span className="text-ink-500"> (send it to the customer to pay the trial)</span>
        </div>
      )}

      {!done && (
        <>
          <div>
            <Button variant="secondary" disabled={busy} onClick={() => run(() => supabase.rpc('admin_match_lead', { p_lead: leadId }), 'Matching re-run.')}>
              Re-run matching
            </Button>
            <p className="mt-1 text-xs text-ink-500">Uses the latest capacity, plans and ratings.</p>
          </div>

          <div className="space-y-2">
            <Field label="Place with a kitchen" hint="Listed kitchens within 8 km. Picks the plan that fits the meal times and food.">
              <Select value={kitchen} onChange={(e) => setKitchen(e.target.value)} disabled={!kitchens.length}>
                {!kitchens.length && <option value="">No listed kitchen nearby</option>}
                {kitchens.map((k) => (
                  <option key={k.kitchen_id} value={k.kitchen_id}>
                    {k.name} · {k.distance_km} km{Number(k.distance_km) > Number(k.radius_km) ? ' (outside radius)' : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <Button disabled={busy || !kitchen} onClick={assign}>Assign to kitchen</Button>
          </div>

          <div className="space-y-2 border-t border-ink-100 pt-4">
            <div className="flex flex-wrap gap-2">
              {status !== 'waitlist' && (
                <Button variant="secondary" disabled={busy} onClick={() => run(() => supabase.rpc('admin_set_lead_status', { p_lead: leadId, p_status: 'waitlist' }), 'Moved to the waitlist.')}>
                  Move to waitlist
                </Button>
              )}
              {status === 'lost' && (
                <Button variant="secondary" disabled={busy} onClick={() => run(() => supabase.rpc('admin_set_lead_status', { p_lead: leadId, p_status: 'new' }), 'Reopened.')}>
                  Reopen
                </Button>
              )}
            </div>
            {status !== 'lost' && (
              <div className="flex gap-2">
                <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (e.g. too far, price)" aria-label="Lost reason" />
                <Button variant="danger" disabled={busy || !reason.trim()}
                  onClick={() => run(() => supabase.rpc('admin_set_lead_status', { p_lead: leadId, p_status: 'lost', p_reason: reason.trim() }), 'Marked as lost.')}>
                  Mark lost
                </Button>
              </div>
            )}
          </div>
        </>
      )}
      {done && <p className="text-ink-500">This lead is placed with a kitchen. The funnel now moves with their payments.</p>}
    </div>
  );
}
