'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { normalizePhone, rupeesToPaise } from '@tiffin/core';
import type { DietType, MealSlot } from '@tiffin/db';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyErrorIn } from '@/lib/errors';
import { SOURCE_LABEL, type LeadSource } from '@/lib/public';
import { Alert, Button, Field, Input, Select, Textarea } from '@/components/ui';

const SLOTS: Record<string, MealSlot[]> = { lunch: ['lunch'], dinner: ['dinner'], both: ['lunch', 'dinner'] };

// Calls and walk-ins: the team enters what the caller said; matching runs straight away.
export function NewLeadForm({ areas }: { areas: string[] }) {
  const router = useRouter();
  const [f, setF] = useState({
    name: '', phone: '', source: 'call' as LeadSource, campaign: '', area: '', meals: 'lunch', diet: 'veg' as DietType,
    budget: '', start: '', whatsapp: true, notes: '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const phone = normalizePhone(f.phone);
    if (!phone) return setError('Enter a valid 10-digit Indian mobile number.');
    const budget = f.budget.trim() ? rupeesToPaise(f.budget) : null;
    if (f.budget.trim() && (budget == null || budget < 1000 || budget > 100000)) return setError('Budget per meal must be between ₹10 and ₹1,000.');
    setBusy(true);
    const { data, error } = await supabaseBrowser().rpc('admin_create_lead', {
      p_name: f.name.trim(), p_phone: phone, p_source: f.source, p_campaign: f.campaign.trim() || undefined,
      p_area: f.area || undefined, p_slots: SLOTS[f.meals], p_diet: f.diet, p_budget_paise: budget ?? undefined,
      p_start: f.start || undefined, p_whatsapp_opt_in: f.whatsapp, p_notes: f.notes.trim() || undefined,
    });
    setBusy(false);
    if (error) return setError(friendlyErrorIn('admin', error));
    router.push(`/admin/leads/${(data as { lead_id: string }).lead_id}`);
  }

  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={80} /></Field>
      <Field label="Mobile"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} inputMode="numeric" required /></Field>
      <Field label="Source">
        <Select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value as LeadSource })}>
          {(Object.keys(SOURCE_LABEL) as LeadSource[]).map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
        </Select>
      </Field>
      <Field label="Campaign (optional)"><Input value={f.campaign} onChange={(e) => setF({ ...f, campaign: e.target.value })} maxLength={60} /></Field>
      <Field label="Area">
        <Select value={f.area} onChange={(e) => setF({ ...f, area: e.target.value })}>
          <option value="">Unknown</option>
          {areas.map((a) => <option key={a} value={a}>{a}</option>)}
        </Select>
      </Field>
      <Field label="Meals">
        <Select value={f.meals} onChange={(e) => setF({ ...f, meals: e.target.value })}>
          <option value="lunch">Lunch</option><option value="dinner">Dinner</option><option value="both">Lunch + dinner</option>
        </Select>
      </Field>
      <Field label="Food">
        <Select value={f.diet} onChange={(e) => setF({ ...f, diet: e.target.value as DietType })}>
          <option value="veg">Veg</option><option value="nonveg">Non-veg</option><option value="jain">Jain</option>
        </Select>
      </Field>
      <Field label="Budget per meal (₹)"><Input value={f.budget} onChange={(e) => setF({ ...f, budget: e.target.value })} inputMode="decimal" placeholder="e.g. 70" /></Field>
      <Field label="Start date"><Input type="date" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></Field>
      <Field label="Notes" className="sm:col-span-2"><Textarea rows={1} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      <label className="flex items-center gap-2 self-end pb-2 text-sm">
        <input type="checkbox" checked={f.whatsapp} onChange={(e) => setF({ ...f, whatsapp: e.target.checked })} /> WhatsApp updates OK
      </label>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2 lg:col-span-4">
        <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save and match'}</Button>
        <span className="text-xs text-ink-500">Only save a lead after the caller agreed to be contacted about their enquiry.</span>
        <Alert>{error}</Alert>
      </div>
    </form>
  );
}
