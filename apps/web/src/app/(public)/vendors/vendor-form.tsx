'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { formatPhone, normalizePhone } from '@tiffin/core';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyErrorIn } from '@/lib/errors';
import { track } from '@/lib/analytics';
import type { LeadSource } from '@/lib/public';
import { Alert, Button, Field, Input } from '@/components/ui';

export function VendorForm({ areas, source, campaign }: { areas: string[]; source: LeadSource; campaign: string | null }) {
  const [f, setF] = useState({ name: '', phone: '', kitchen: '', area: '', subscribers: '', fssai: '', consent: false, whatsapp: true });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const phone = normalizePhone(f.phone);
    if (!f.name.trim()) return setError('Please enter your name.');
    if (!phone) return setError('Enter a valid 10-digit Indian mobile number.');
    const fssai = f.fssai.replace(/\s/g, '');
    if (fssai && !/^\d{14}$/.test(fssai)) return setError('FSSAI numbers have 14 digits. Leave it empty if you don’t have it yet.');
    if (!f.consent) return setError('Please tick the box to agree to be contacted.');
    const subs = f.subscribers ? Number(f.subscribers) : undefined;
    setBusy(true);
    const { error } = await supabaseBrowser().rpc('submit_vendor_application', {
      p_name: f.name.trim(),
      p_phone: phone,
      p_kitchen_name: f.kitchen.trim() || undefined,
      p_area: f.area.trim() || undefined,
      p_subscribers: subs != null && Number.isFinite(subs) ? Math.max(0, Math.min(5000, Math.round(subs))) : undefined,
      p_fssai: fssai || undefined,
      p_source: source,
      p_campaign: campaign ?? undefined,
      p_consent: true,
      p_whatsapp_opt_in: f.whatsapp,
    });
    setBusy(false);
    if (error) return setError(friendlyErrorIn('public', error));
    // Area only when it is one of the known areas (the field is free text).
    const area = areas.find((a) => a.toLowerCase() === f.area.trim().toLowerCase()) ?? (f.area.trim() ? 'other' : null);
    track('vendor_applied', { source, campaign, area });
    setDone(phone);
  }

  if (done) {
    return (
      <aside className="h-fit rounded-2xl bg-white p-6 shadow-sm ring-1 ring-ink-100">
        <div className="text-4xl" aria-hidden>🙏</div>
        <h2 className="mt-2 text-lg font-semibold">Thank you, {f.name.trim().split(' ')[0]}!</h2>
        <p className="mt-1 text-sm text-ink-700">Our team will call or WhatsApp you on {formatPhone(done)} within a day.</p>
        <p className="mt-4 text-sm font-medium text-ink-900">Don’t want to wait?</p>
        <Link href="/login" className="mt-2 inline-flex w-full items-center justify-center rounded-lg bg-brand-600 px-4 py-3 font-medium text-white hover:bg-brand-700">
          Start now: log in with this number
        </Link>
        <p className="mt-2 text-xs text-ink-500">Set up your plans and customers today. It’s free.</p>
      </aside>
    );
  }

  return (
    <aside className="h-fit rounded-2xl bg-white p-5 shadow-sm ring-1 ring-ink-100">
      <h2 className="text-lg font-semibold">Join free</h2>
      <form onSubmit={submit} className="mt-3 space-y-3">
        <Field label="Your name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="name" maxLength={80} required /></Field>
        <Field label="Mobile number">
          <div className="flex">
            <span className="inline-flex items-center rounded-l-lg bg-ink-100 px-3 text-sm text-ink-500 ring-1 ring-ink-200">+91</span>
            <Input className="rounded-l-none" inputMode="numeric" autoComplete="tel-national" placeholder="98610 00000"
              value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} required />
          </div>
        </Field>
        <Field label="Kitchen name"><Input value={f.kitchen} onChange={(e) => setF({ ...f, kitchen: e.target.value })} maxLength={80} placeholder="e.g. Maa Mangala Tiffin" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Area">
            <Input list="vendor-areas" value={f.area} onChange={(e) => setF({ ...f, area: e.target.value })} placeholder="e.g. Patia" />
            <datalist id="vendor-areas">{areas.map((a) => <option key={a} value={a} />)}</datalist>
          </Field>
          <Field label="Customers today"><Input type="number" min={0} max={5000} inputMode="numeric" value={f.subscribers} onChange={(e) => setF({ ...f, subscribers: e.target.value })} placeholder="approx." /></Field>
        </div>
        <Field label="FSSAI number (optional)" hint="14 digits. You can add it later.">
          <Input inputMode="numeric" maxLength={17} value={f.fssai} onChange={(e) => setF({ ...f, fssai: e.target.value })} />
        </Field>
        <label className="flex items-start gap-2 text-sm text-ink-700">
          <input type="checkbox" className="mt-0.5" checked={f.consent} onChange={(e) => setF({ ...f, consent: e.target.checked })} required />
          <span>I agree to be contacted about joining Tiffin Bhubaneswar</span>
        </label>
        <label className="flex items-start gap-2 text-sm text-ink-700">
          <input type="checkbox" className="mt-0.5" checked={f.whatsapp} onChange={(e) => setF({ ...f, whatsapp: e.target.checked })} />
          <span>Send me setup help on WhatsApp</span>
        </label>
        <Alert>{error}</Alert>
        <Button type="submit" className="w-full py-3 text-base" disabled={busy}>{busy ? 'Sending…' : 'Join free'}</Button>
      </form>
    </aside>
  );
}
