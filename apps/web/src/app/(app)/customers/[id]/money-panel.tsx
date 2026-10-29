'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatPaise, rupeesToPaise } from '@tiffin/core';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { whatsappUrl } from '@/lib/whatsapp';
import { Alert, Button, Card, Field, Input, Select } from '@/components/ui';
import { METHOD_LABEL, PaymentStatus, RefundStatus } from '@/components/payment-badges';

type Payment = { id: string; method: string; status: 'created' | 'pending' | 'paid' | 'failed' | 'expired' | 'cancelled' | 'review'; amount_paise: number; meals: number; short_url: string | null; created_at: string };
type Refund = { id: string; meals: number; amount_paise: number; status: 'pending' | 'processing' | 'processed' | 'failed'; method: string | null; payment_id: string | null; created_at: string };

type Props = {
  kitchenId: string;
  kitchenName: string;
  customerId: string;
  customerName: string;
  customerPhone: string | null;
  balanceMeals: number;
  valuePaise: number;
  unitPricePaise: number | null;
  onlineEnabled: boolean;
  payments: Payment[];
  refunds: Refund[];
};

type Mode = null | 'cash' | 'link' | 'entry' | 'refund';
const day = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' });

export function MoneyPanel(p: Props) {
  const router = useRouter();
  const supabase = supabaseBrowser();
  const [mode, setMode] = useState<Mode>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);

  // record payment
  const [amount, setAmount] = useState('');
  const [meals, setMeals] = useState('');
  const [method, setMethod] = useState<'cash' | 'upi_manual' | 'bank_transfer'>('cash');
  const [photo, setPhoto] = useState<File | null>(null);
  // link
  const [linkMeals, setLinkMeals] = useState('26');
  const [link, setLink] = useState<{ url: string; amount: number; meals: number } | null>(null);
  // entry
  const [entryType, setEntryType] = useState<'credit' | 'adjust'>('credit');
  const [entryMeals, setEntryMeals] = useState('1');
  const [reason, setReason] = useState('');
  // refund
  const [refundMeals, setRefundMeals] = useState('');
  const [refundValue, setRefundValue] = useState<{ meals: number; amount_paise: number } | null>(null);

  const paise = rupeesToPaise(amount);
  const autoMeals = paise && p.unitPricePaise ? Math.floor(paise / p.unitPricePaise) : 0;

  function open(m: Mode) {
    setMode(m);
    setError('');
    setDone('');
    setLink(null);
    if (m === 'refund') {
      void supabase.rpc('unused_meals_value', { p_customer: p.customerId }).then(({ data, error }) => {
        if (error) setError(friendlyError(error));
        else setRefundValue(data as unknown as { meals: number; amount_paise: number });
      });
    }
  }

  async function finish(err: { message?: string; code?: string } | null, message: string) {
    setBusy(false);
    if (err) return setError(friendlyError(err));
    setDone(message);
    setMode(null);
    router.refresh();
  }

  async function recordPayment() {
    if (!paise) return setError('Enter the amount in rupees.');
    setBusy(true);
    setError('');
    let path: string | undefined;
    if (photo) {
      const ext = photo.name.split('.').pop()?.toLowerCase() || 'jpg';
      path = `${p.kitchenId}/${crypto.randomUUID()}.${ext}`;
      const { error } = await supabase.storage.from('receipts').upload(path, photo, { contentType: photo.type });
      if (error) {
        setBusy(false);
        return setError(`Photo upload failed: ${error.message}`);
      }
    }
    const { error } = await supabase.rpc('record_payment', {
      p_customer: p.customerId, p_amount_paise: paise, p_method: method,
      p_meals: meals ? Number(meals) : undefined, p_receipt_photo_path: path,
    });
    await finish(error, `${formatPaise(paise)} recorded.`);
    setAmount('');
    setMeals('');
    setPhoto(null);
  }

  async function createLink() {
    setBusy(true);
    setError('');
    const { data, error } = await supabase.functions.invoke('razorpay-payment-link', {
      body: { customer_id: p.customerId, meals: Number(linkMeals) },
    });
    setBusy(false);
    if (error) {
      const body = await (error as { context?: Response }).context?.json?.().catch(() => null);
      return setError(friendlyError({ message: body?.error ?? error.message }));
    }
    const res = data as { short_url: string; amount_paise: number; meals: number };
    setLink({ url: res.short_url, amount: res.amount_paise, meals: res.meals });
    router.refresh();
  }

  async function addEntry() {
    setBusy(true);
    setError('');
    const n = Number(entryMeals);
    const { error } = await supabase.rpc('add_balance_entry', { p_customer: p.customerId, p_type: entryType, p_meals: n, p_reason: reason });
    await finish(error, entryType === 'credit' ? `${n} free meal(s) added.` : 'Balance adjusted.');
    setReason('');
  }

  async function refund() {
    setBusy(true);
    setError('');
    const { error } = await supabase.rpc('refund_unused_meals', { p_customer: p.customerId, p_meals: refundMeals ? Number(refundMeals) : undefined });
    await finish(error, 'Refund created. Pay it below.');
    setRefundMeals('');
  }

  async function payRefund(r: Refund, how: 'cash' | 'upi_manual' | 'razorpay') {
    setBusy(true);
    setError('');
    if (how === 'razorpay') {
      const { error } = await supabase.functions.invoke('razorpay-refund', { body: { refund_id: r.id } });
      if (error) {
        const body = await (error as { context?: Response }).context?.json?.().catch(() => null);
        return finish({ message: body?.error ?? error.message }, '');
      }
      return finish(null, 'Online refund started.');
    }
    const { error } = await supabase.rpc('mark_refund_paid', { p_refund: r.id, p_method: how });
    await finish(error, 'Refund marked as paid.');
  }

  async function confirmPending(pay: Payment, ok: boolean) {
    setBusy(true);
    const { error } = ok
      ? await supabase.rpc('confirm_payment', { p_payment: pay.id })
      : await supabase.rpc('reject_payment', { p_payment: pay.id, p_reason: 'Not received' });
    await finish(error, ok ? 'Cash confirmed.' : 'Marked as not received.');
  }

  const linkMessage = link
    ? `Namaskar ${p.customerName}, please pay ${formatPaise(link.amount)} for ${link.meals} meals at ${p.kitchenName}: ${link.url}`
    : '';

  return (
    <Card title="Money">
      <div className="flex items-baseline gap-2">
        <span className={`text-3xl font-semibold ${p.balanceMeals < 0 ? 'text-red-700' : ''}`}>{p.balanceMeals}</span>
        <span className="text-ink-500">meals</span>
      </div>
      <p className="text-sm text-ink-500">
        {p.balanceMeals < 0
          ? `Owes ${-p.balanceMeals} meal(s)${p.unitPricePaise ? ` · ${formatPaise(-p.balanceMeals * p.unitPricePaise)}` : ''}`
          : `${formatPaise(p.valuePaise)} prepaid value`}
        {p.unitPricePaise ? ` · ${formatPaise(p.unitPricePaise)} per meal` : ''}
      </p>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <Button variant={mode === 'cash' ? 'primary' : 'secondary'} className="px-3 py-1" onClick={() => open('cash')}>Record payment</Button>
        <Button variant={mode === 'link' ? 'primary' : 'secondary'} className="px-3 py-1" onClick={() => open('link')}>Payment link</Button>
        <Button variant={mode === 'entry' ? 'primary' : 'secondary'} className="px-3 py-1" onClick={() => open('entry')}>Credit / adjust</Button>
        <Button variant={mode === 'refund' ? 'primary' : 'secondary'} className="px-3 py-1" onClick={() => open('refund')}>Refund</Button>
      </div>
      {done && <div className="mt-2"><Alert tone="green">{done}</Alert></div>}

      {mode === 'cash' && (
        <div className="mt-3 space-y-3 rounded-lg bg-ink-50 p-3 ring-1 ring-ink-200">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Amount (₹)"><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1820" autoFocus /></Field>
            <Field label="Method">
              <Select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
                <option value="cash">Cash</option>
                <option value="upi_manual">UPI to my number</option>
                <option value="bank_transfer">Bank transfer</option>
              </Select>
            </Field>
            <Field label="Meals" hint={autoMeals ? `Default ${autoMeals} at ${formatPaise(p.unitPricePaise!)}/meal` : undefined}>
              <Input inputMode="numeric" value={meals} onChange={(e) => setMeals(e.target.value)} placeholder={autoMeals ? String(autoMeals) : ''} />
            </Field>
            <Field label="Receipt photo (optional)">
              <input type="file" accept="image/*,application/pdf" capture="environment" className="text-sm" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
            </Field>
          </div>
          {p.unitPricePaise && (
            <div className="flex flex-wrap gap-1.5 text-xs">
              {[10, 26, 30].map((n) => (
                <button key={n} type="button" className="rounded-full bg-white px-2.5 py-1 ring-1 ring-ink-200 hover:bg-brand-50"
                  onClick={() => { setAmount(String((n * p.unitPricePaise!) / 100)); setMeals(String(n)); }}>
                  {n} meals · {formatPaise(n * p.unitPricePaise!)}
                </button>
              ))}
            </div>
          )}
          <Button onClick={recordPayment} disabled={busy || !paise}>{busy ? 'Saving…' : `Save ${paise ? formatPaise(paise) : ''}`}</Button>
          <p className="text-xs text-ink-500">A receipt is sent to the customer on WhatsApp once WhatsApp is connected.</p>
        </div>
      )}

      {mode === 'link' && (
        <div className="mt-3 space-y-3 rounded-lg bg-ink-50 p-3 ring-1 ring-ink-200">
          {!p.onlineEnabled ? (
            <Alert tone="amber">Online payments start once your Razorpay payout account is verified (the money goes straight to your bank). Record cash or UPI meanwhile.</Alert>
          ) : link ? (
            <>
              <p className="text-sm">Link for <strong>{formatPaise(link.amount)}</strong> ({link.meals} meals):</p>
              <Input readOnly value={link.url} onFocus={(e) => e.target.select()} />
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => navigator.clipboard?.writeText(link.url)}>Copy link</Button>
                <a href={whatsappUrl(p.customerPhone, linkMessage)} target="_blank" rel="noreferrer"
                   className="inline-flex items-center rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700">
                  Send on WhatsApp
                </a>
              </div>
              <p className="text-xs text-ink-500">The balance updates by itself when the customer pays.</p>
            </>
          ) : (
            <>
              <Field label="Meals">
                <div className="flex flex-wrap gap-1.5">
                  {['10', '26', '30', '60'].map((n) => (
                    <button key={n} type="button" onClick={() => setLinkMeals(n)}
                      className={`rounded-full px-3 py-1 text-sm ring-1 ${linkMeals === n ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white ring-ink-200'}`}>
                      {n}{p.unitPricePaise ? ` · ${formatPaise(Number(n) * p.unitPricePaise)}` : ''}
                    </button>
                  ))}
                  <Input className="w-24" inputMode="numeric" value={linkMeals} onChange={(e) => setLinkMeals(e.target.value)} />
                </div>
              </Field>
              <Button onClick={createLink} disabled={busy || !Number(linkMeals)}>{busy ? 'Creating…' : 'Create payment link'}</Button>
              <p className="text-xs text-ink-500">Razorpay test mode. Refund and cancellation terms are shown before payment (customer page, next milestone).</p>
            </>
          )}
        </div>
      )}

      {mode === 'entry' && (
        <div className="mt-3 space-y-3 rounded-lg bg-ink-50 p-3 ring-1 ring-ink-200">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type">
              <Select value={entryType} onChange={(e) => setEntryType(e.target.value as 'credit' | 'adjust')}>
                <option value="credit">Free meal (kitchen’s fault)</option>
                <option value="adjust">Opening balance / correction</option>
              </Select>
            </Field>
            <Field label="Meals" hint={entryType === 'adjust' ? 'Use a negative number to reduce.' : undefined}>
              <Input inputMode="numeric" value={entryMeals} onChange={(e) => setEntryMeals(e.target.value)} />
            </Field>
          </div>
          <Field label="Reason (kept in the audit log)"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={entryType === 'credit' ? 'Delivered 1 hour late' : 'Paid in October register'} /></Field>
          <Button onClick={addEntry} disabled={busy || !reason.trim() || !Number(entryMeals)}>{busy ? 'Saving…' : 'Save'}</Button>
        </div>
      )}

      {mode === 'refund' && (
        <div className="mt-3 space-y-3 rounded-lg bg-ink-50 p-3 ring-1 ring-ink-200">
          {refundValue && (
            <p className="text-sm">Unused: <strong>{refundValue.meals} meals</strong> worth <strong>{formatPaise(refundValue.amount_paise)}</strong> (valued at what the customer paid, oldest purchases used first).</p>
          )}
          <Field label="Meals to refund (empty = all unused)"><Input inputMode="numeric" value={refundMeals} onChange={(e) => setRefundMeals(e.target.value)} /></Field>
          <Button onClick={refund} disabled={busy || !refundValue?.meals}>{busy ? 'Saving…' : 'Create refund'}</Button>
        </div>
      )}
      {error && <div className="mt-2"><Alert>{error}</Alert></div>}

      {p.refunds.length > 0 && (
        <>
          <h3 className="mt-5 text-sm font-semibold">Refunds</h3>
          <ul className="divide-y divide-ink-100 text-sm">
            {p.refunds.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>{day(r.created_at)} · {r.meals} meals · <strong>{formatPaise(r.amount_paise)}</strong></span>
                <span className="flex items-center gap-1.5">
                  <RefundStatus status={r.status} />
                  {(r.status === 'pending' || r.status === 'failed') && (
                    <>
                      <Button variant="secondary" className="px-2 py-0.5 text-xs" disabled={busy} onClick={() => payRefund(r, 'cash')}>Paid cash</Button>
                      <Button variant="secondary" className="px-2 py-0.5 text-xs" disabled={busy} onClick={() => payRefund(r, 'upi_manual')}>Paid UPI</Button>
                      {r.payment_id && <Button variant="secondary" className="px-2 py-0.5 text-xs" disabled={busy} onClick={() => payRefund(r, 'razorpay')}>Refund online</Button>}
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3 className="mt-5 text-sm font-semibold">Payments</h3>
      <ul className="divide-y divide-ink-100 text-sm">
        {p.payments.map((pay) => (
          <li key={pay.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span>
              {day(pay.created_at)} · {METHOD_LABEL[pay.method] ?? pay.method} · <strong>{formatPaise(pay.amount_paise)}</strong>
              <span className="text-ink-500"> ({pay.meals} meals)</span>
            </span>
            <span className="flex items-center gap-1.5">
              <PaymentStatus status={pay.status} />
              {pay.status === 'pending' && (
                <>
                  <Button variant="secondary" className="px-2 py-0.5 text-xs" disabled={busy} onClick={() => confirmPending(pay, true)}>Confirm</Button>
                  <Button variant="ghost" className="px-2 py-0.5 text-xs" disabled={busy} onClick={() => confirmPending(pay, false)}>Not received</Button>
                </>
              )}
              {pay.status === 'paid' && <a href={`/print/receipt/${pay.id}`} className="text-xs text-brand-700 hover:underline">Receipt</a>}
              {pay.status === 'created' && pay.short_url && (
                <a href={whatsappUrl(p.customerPhone, `Namaskar ${p.customerName}, please pay ${formatPaise(pay.amount_paise)} for ${pay.meals} meals at ${p.kitchenName}: ${pay.short_url}`)}
                   target="_blank" rel="noreferrer" className="text-xs text-green-700 hover:underline">Resend</a>
              )}
            </span>
          </li>
        ))}
        {p.payments.length === 0 && <li className="py-2 text-ink-500">No payments yet.</li>}
      </ul>
    </Card>
  );
}
