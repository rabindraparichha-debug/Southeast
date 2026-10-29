'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatPaise, formatServiceDate, isoDow } from '@tiffin/core';
import type { ChangeResult } from '@tiffin/db';
import { supabaseBrowser } from '@/lib/supabase/client';
import { tr, type Lang, type Key } from './i18n';

type Meal = { subscription_id: string; date: string; slot: 'lunch' | 'dinner'; qty: number; status: string; charged: boolean; skip_reason: string | null; locked: boolean; open: boolean };
export type Portal = {
  language: Lang;
  customer: { id: string; name: string };
  phone_masked: string;
  kitchen: { name: string; fssai_no: string | null; online_payments: boolean; weekly_off: number[] };
  balance: { meals: number; value_paise: number };
  subscriptions: { id: string; status: string; plan: string; price_paise: number }[];
  meals: Meal[];
  menus: { date: string; slot: string; dishes: string[] }[];
  addresses: { id: string; label: string | null; line1: string | null; area: string | null; landmark: string | null; is_default: boolean }[];
  payments: { date: string; amount_paise: number; meals: number; method: string; status: string; short_url: string | null }[];
  refunds: { date: string; meals: number; amount_paise: number; status: string }[];
};

const SLOT = { lunch: 'Lunch', dinner: 'Dinner' } as const;
const btn = 'rounded-lg px-3 py-2 text-sm font-medium ring-1 ring-ink-200 bg-white active:bg-ink-50 disabled:opacity-50';

export function PortalClient({ token, initial, grievance }: { token: string; initial: Portal; grievance: string }) {
  const router = useRouter();
  const supabase = supabaseBrowser();
  const p = initial;
  const [lang, setLang] = useState<Lang>(p.language ?? 'en');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [confirm, setConfirm] = useState<{ meal: Meal } | null>(null);
  const [addr, setAddr] = useState({ line1: '', area: '', landmark: '', notes: '' });
  const [complaint, setComplaint] = useState({ category: 'quality', text: '' });
  const [review, setReview] = useState({ rating: 0, comment: '', sent: false });
  const t = (k: Key, v?: Record<string, string | number>) => tr(lang, k, v);
  const live = p.subscriptions.filter((s) => ['active', 'low_balance', 'paused'].includes(s.status));
  const price = live[0]?.price_paise ?? p.subscriptions[0]?.price_paise;
  const firstOpen = p.meals.find((m) => m.open)?.date;
  const menus = p.menus.filter((m) => !(p.kitchen.weekly_off ?? []).includes(isoDow(m.date)));

  async function run<T>(fn: () => PromiseLike<{ data: T; error: { message: string } | null }>, ok?: string): Promise<T | null> {
    setBusy(true);
    setMsg('');
    const { data, error } = await fn();
    setBusy(false);
    if (error) {
      setMsg(error.message === 'invalid_link' ? 'This link has expired. Send “my page” on WhatsApp for a new one.' : 'Sorry, that did not work. Please try again.');
      return null;
    }
    if (ok) setMsg(ok);
    router.refresh();
    return data;
  }

  async function skip(meal: Meal, force = false) {
    const args = { p_token: token, p_subscription: meal.subscription_id, p_type: 'skip' as const, p_from: meal.date, p_to: meal.date, p_slot: meal.slot };
    if (!force) {
      const preview = await run(() => supabase.rpc('portal_change', { ...args, p_dry_run: true }));
      if (!preview) return;
      if ((preview as unknown as ChangeResult).affected.some((a) => a.charged)) return setConfirm({ meal });
    }
    setConfirm(null);
    await run(() => supabase.rpc('portal_change', { ...args, p_dry_run: false }), t('done'));
  }

  async function undo(meal: Meal) {
    await run(() => supabase.rpc('portal_change', { p_token: token, p_subscription: meal.subscription_id, p_type: 'resume', p_from: meal.date, p_slot: meal.slot, p_dry_run: false }), t('done'));
  }

  async function pause(days: number | null) {
    if (!firstOpen) return;
    const to = days ? new Date(Date.parse(`${firstOpen}T00:00:00Z`) + (days - 1) * 86_400_000).toISOString().slice(0, 10) : undefined;
    for (const s of live) await run(() => supabase.rpc('portal_change', { p_token: token, p_subscription: s.id, p_type: 'pause', p_from: firstOpen, p_to: to, p_dry_run: false }));
    setMsg(t('done'));
  }

  async function resume() {
    const from = p.meals.find((m) => m.open && m.status === 'skipped')?.date ?? firstOpen;
    if (!from) return;
    for (const s of live) await run(() => supabase.rpc('portal_change', { p_token: token, p_subscription: s.id, p_type: 'resume', p_from: from, p_dry_run: false }));
    setMsg(t('done'));
  }

  async function pay(meals: number) {
    setBusy(true);
    const { data, error } = await supabase.functions.invoke('razorpay-payment-link', { body: { token, meals } });
    setBusy(false);
    if (error || !(data as { short_url?: string })?.short_url) return setMsg('Payment is not available right now. Please pay your kitchen directly.');
    window.location.assign((data as { short_url: string }).short_url);
  }

  async function addAddress() {
    const id = await run(() => supabase.rpc('portal_add_address', { p_token: token, p_line1: addr.line1, p_area: addr.area, p_landmark: addr.landmark, p_delivery_notes: addr.notes }));
    if (id) await deliverHere(id as unknown as string);
    setAddr({ line1: '', area: '', landmark: '', notes: '' });
  }

  async function deliverHere(addressId: string) {
    const from = firstOpen ?? new Date().toISOString().slice(0, 10);
    for (const s of live) await run(() => supabase.rpc('portal_change', { p_token: token, p_subscription: s.id, p_type: 'address', p_from: from, p_address: addressId, p_dry_run: false }));
    setMsg(t('done'));
  }

  async function sendComplaint(category = complaint.category, text = complaint.text) {
    await run(() => supabase.rpc('portal_complaint', { p_token: token, p_category: category, p_description: text }), t('done'));
    setComplaint({ category: 'quality', text: '' });
  }

  async function sendReview() {
    setBusy(true);
    setMsg('');
    const { error } = await supabase.rpc('portal_review', { p_token: token, p_rating: review.rating, p_comment: review.comment.trim() || undefined });
    setBusy(false);
    if (error) return setMsg(error.message === 'invalid_link' ? 'This link has expired. Send “my page” on WhatsApp for a new one.' : 'Sorry, that did not work. Please try again.');
    setReview({ ...review, sent: true });
  }

  async function changeLanguage(l: Lang) {
    setLang(l);
    await run(() => supabase.rpc('portal_set_language', { p_token: token, p_language: l }));
  }

  const card = 'rounded-2xl bg-white p-4 shadow-sm ring-1 ring-ink-100';
  return (
    <main className="mx-auto max-w-md space-y-4 px-4 py-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">{p.kitchen.name}</h1>
          <p className="text-xs text-ink-500">{p.customer.name} · {p.phone_masked}{p.kitchen.fssai_no ? ` · FSSAI ${p.kitchen.fssai_no}` : ''}</p>
        </div>
        <select aria-label={t('language')} value={lang} onChange={(e) => changeLanguage(e.target.value as Lang)} className="rounded-lg px-2 py-1 text-sm ring-1 ring-ink-200">
          <option value="or">ଓଡ଼ିଆ</option><option value="hi">हिंदी</option><option value="en">English</option>
        </select>
      </header>

      {msg && <div role="status" className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800 ring-1 ring-green-200">{msg}</div>}

      <section className={card}>
        <div className="text-sm text-ink-500">{t('balance')}</div>
        <div className={`text-4xl font-semibold ${p.balance.meals < 0 ? 'text-red-700' : ''}`}>{p.balance.meals}</div>
        <div className="text-sm text-ink-500">{p.balance.meals < 0 ? t('owes', { n: -p.balance.meals }) : t('prepaid', { v: formatPaise(p.balance.value_paise) })}</div>
        <h2 className="mt-4 text-sm font-semibold">{t('pay')}</h2>
        {p.kitchen.online_payments && price ? (
          <>
            <p className="mt-1 text-xs text-ink-500">{t('pay_terms')}</p>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {[10, 26, 30].map((n) => (
                <button key={n} disabled={busy} onClick={() => pay(n)} className="rounded-lg bg-brand-600 px-2 py-2 text-sm font-medium text-white disabled:opacity-50">
                  {n} · {formatPaise(n * price)}
                </button>
              ))}
            </div>
          </>
        ) : (
          <p className="mt-1 text-sm text-ink-600">{t('pay_offline')}</p>
        )}
      </section>

      <section className={card}>
        <h2 className="mb-2 text-sm font-semibold">{t('upcoming')}</h2>
        <ul className="divide-y divide-ink-100">
          {p.meals.map((m) => (
            <li key={`${m.subscription_id}-${m.date}-${m.slot}`} className="flex items-center justify-between gap-2 py-2 text-sm">
              <span>{formatServiceDate(m.date)} · {SLOT[m.slot]}{m.qty > 1 ? ` ×${m.qty}` : ''}</span>
              {m.status === 'skipped' ? (
                <span className="flex items-center gap-2 text-ink-500">
                  {m.charged ? t('late_charged') : m.skip_reason === 'pause' ? t('paused') : t('skipped')}
                  {m.open && !m.charged && <button className="text-brand-700 underline" disabled={busy} onClick={() => undo(m)}>{t('undo')}</button>}
                </span>
              ) : m.locked || !m.open ? (
                <span className="flex items-center gap-2 text-ink-500">{t('locked')}
                  {m.status === 'scheduled' && <button className="text-ink-500 underline" disabled={busy} onClick={() => skip(m)}>{t('skip')}</button>}
                </span>
              ) : (
                <button className={btn} disabled={busy} onClick={() => skip(m)}>{t('skip')}</button>
              )}
            </li>
          ))}
        </ul>
        {confirm && (
          <div className="mt-3 rounded-lg bg-amber-50 p-3 text-sm ring-1 ring-amber-200">
            <p>{t('late_warning')}</p>
            <div className="mt-2 flex gap-2">
              <button className={btn} onClick={() => skip(confirm.meal, true)}>{t('confirm')}</button>
              <button className={btn} onClick={() => setConfirm(null)}>{t('cancel')}</button>
            </div>
          </div>
        )}
        <h3 className="mt-4 text-sm font-semibold">{t('pause_title')}</h3>
        <div className="mt-2 flex flex-wrap gap-2">
          {live.some((s) => s.status === 'paused') || p.meals.some((m) => m.open && m.skip_reason === 'pause') ? (
            <button className={btn} disabled={busy} onClick={resume}>{t('resume')}</button>
          ) : (
            <>
              <button className={btn} disabled={busy || !firstOpen} onClick={() => pause(3)}>{t('pause_3')}</button>
              <button className={btn} disabled={busy || !firstOpen} onClick={() => pause(7)}>{t('pause_7')}</button>
              <button className={btn} disabled={busy || !firstOpen} onClick={() => pause(null)}>{t('pause_open')}</button>
            </>
          )}
        </div>
      </section>

      {menus.length > 0 && (
        <section className={card}>
          <h2 className="mb-2 text-sm font-semibold">{t('menu')}</h2>
          <ul className="space-y-1 text-sm">
            {menus.map((m) => (
              <li key={`${m.date}-${m.slot}`}><span className="text-ink-500">{formatServiceDate(m.date)} {SLOT[m.slot as 'lunch' | 'dinner']}:</span> {m.dishes.join(', ')}</li>
            ))}
          </ul>
        </section>
      )}

      <section className={card}>
        <h2 className="mb-2 text-sm font-semibold">{t('address')}</h2>
        <ul className="space-y-2 text-sm">
          {p.addresses.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-2">
              <span>{[a.line1, a.landmark, a.area].filter(Boolean).join(', ') || a.label}{a.is_default ? ' ✓' : ''}</span>
              {!a.is_default && <button className={btn} disabled={busy} onClick={() => deliverHere(a.id)}>{t('deliver_here')}</button>}
            </li>
          ))}
        </ul>
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-medium text-brand-700">{t('add_address')}</summary>
          <div className="mt-2 space-y-2">
            {(['line1', 'area', 'landmark', 'notes'] as const).map((f) => (
              <input key={f} value={addr[f]} onChange={(e) => setAddr({ ...addr, [f]: e.target.value })}
                placeholder={{ line1: 'Flat / house', area: 'Area', landmark: 'Landmark', notes: 'Delivery notes' }[f]}
                className="w-full rounded-lg px-3 py-2 text-sm ring-1 ring-ink-200" />
            ))}
            <button className={btn} disabled={busy || !addr.line1.trim()} onClick={addAddress}>{t('save')}</button>
          </div>
        </details>
      </section>

      <section className={card}>
        <h2 className="mb-2 text-sm font-semibold">{t('complaint')}</h2>
        <select value={complaint.category} onChange={(e) => setComplaint({ ...complaint, category: e.target.value })} className="w-full rounded-lg px-3 py-2 text-sm ring-1 ring-ink-200">
          {['late', 'quality', 'quantity', 'missing', 'hygiene', 'delivery', 'billing', 'other'].map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <textarea value={complaint.text} onChange={(e) => setComplaint({ ...complaint, text: e.target.value })} rows={2} className="mt-2 w-full rounded-lg px-3 py-2 text-sm ring-1 ring-ink-200" />
        <button className={`${btn} mt-2`} disabled={busy} onClick={() => sendComplaint()}>{t('complaint_send')}</button>
      </section>

      <section className={card}>
        <h2 className="mb-2 text-sm font-semibold">{t('rate_title')}</h2>
        {review.sent ? (
          <p className="text-sm text-green-800">{t('rate_thanks')}</p>
        ) : (
          <>
            <div className="flex gap-1" role="radiogroup" aria-label={t('rate_title')}>
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} type="button" role="radio" aria-checked={review.rating === n} aria-label={`${n}/5`}
                  onClick={() => setReview({ ...review, rating: n })}
                  className={`text-3xl leading-none ${n <= review.rating ? 'text-amber-500' : 'text-ink-200'}`}>★</button>
              ))}
            </div>
            {review.rating > 0 && (
              <>
                <textarea value={review.comment} onChange={(e) => setReview({ ...review, comment: e.target.value })} rows={2} maxLength={500}
                  placeholder={t('rate_comment')} className="mt-2 w-full rounded-lg px-3 py-2 text-sm ring-1 ring-ink-200" />
                <p className="text-xs text-ink-500">{t('rate_note')}</p>
                <button className={`${btn} mt-2`} disabled={busy} onClick={sendReview}>{t('rate_send')}</button>
              </>
            )}
          </>
        )}
      </section>

      <section className={card}>
        <h2 className="mb-2 text-sm font-semibold">{t('history')}</h2>
        <ul className="space-y-1 text-sm">
          {p.payments.map((x, i) => (
            <li key={`p${i}`} className="flex justify-between">
              <span>{new Date(x.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} · {x.meals} meals</span>
              <span>{formatPaise(x.amount_paise)} {x.status === 'created' && x.short_url ? <a className="text-brand-700 underline" href={x.short_url}>pay</a> : x.status}</span>
            </li>
          ))}
          {p.refunds.map((x, i) => (
            <li key={`r${i}`} className="flex justify-between text-ink-600">
              <span>Refund · {x.meals} meals</span><span>{formatPaise(x.amount_paise)} {x.status}</span>
            </li>
          ))}
        </ul>
      </section>

      <footer className="space-y-2 pb-6 text-xs text-ink-500">
        <p>{t('stopping')}</p>
        {grievance && <p><strong>{t('grievance')}:</strong> {grievance}</p>}
        <button className="underline" disabled={busy} onClick={() => sendComplaint('privacy', 'Please delete my personal data.')}>{t('delete_data')}</button>
      </footer>
    </main>
  );
}
