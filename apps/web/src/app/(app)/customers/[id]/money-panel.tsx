'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { addDays, formatPaise, rupeesToPaise } from '@tiffin/core';
import type { BillingMode, PaymentStatus as PaymentStatusValue } from '@tiffin/db';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError, friendlyErrorIn } from '@/lib/errors';
import { whatsappUrl } from '@/lib/whatsapp';
import { BILLING_LABEL, balanceText, newClientOp, paidAtFor } from '@/lib/money';
import { Alert, Button, Card, Field, Input, LinkButton, Select } from '@/components/ui';
import { METHOD_LABEL, PaymentStatus, RefundStatus } from '@/components/payment-badges';

type Payment = {
  id: string; method: string; status: PaymentStatusValue; amount_paise: number; meals: number; short_url: string | null;
  created_at: string; paid_at: string | null; note: string | null; void_reason: string | null;
};
type Refund = { id: string; meals: number; amount_paise: number; status: 'pending' | 'processing' | 'processed' | 'failed'; method: string | null; payment_id: string | null; created_at: string };

type Props = {
  kitchenId: string;
  kitchenName: string;
  customerId: string;
  customerName: string;
  customerPhone: string | null;
  billingMode: BillingMode;
  balanceMeals: number;
  /** Rupee balance (Σ amount_paise): minus = owed, plus = advance (monthly customers). */
  balancePaise: number;
  valuePaise: number;
  unitPricePaise: number | null;
  onlineEnabled: boolean;
  payments: Payment[];
  refunds: Refund[];
  /** Owner or manager. The accountant reads only. */
  canWrite: boolean;
  /** IST date, for the payment date field. */
  today: string;
  statementHref: string;
};

type Mode = null | 'cash' | 'link' | 'entry' | 'refund' | 'billing';
const day = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' });
const VOIDABLE = new Set(['cash', 'upi_manual', 'bank_transfer']);

export function MoneyPanel(p: Props) {
  const router = useRouter();
  const supabase = supabaseBrowser();
  const monthly = p.billingMode === 'monthly';
  const [mode, setMode] = useState<Mode>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);

  // record payment (one idempotency key per payment: a double tap or a retry saves it once)
  const [amount, setAmount] = useState('');
  const [meals, setMeals] = useState('');
  const [method, setMethod] = useState<'cash' | 'upi_manual' | 'bank_transfer'>('cash');
  const [paidOn, setPaidOn] = useState(p.today);
  const [payNote, setPayNote] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [clientOp, setClientOp] = useState(newClientOp);
  // link
  const [linkMeals, setLinkMeals] = useState('26');
  const [link, setLink] = useState<{ url: string; amount: number; meals: number } | null>(null);
  // entry
  const [entryType, setEntryType] = useState<'credit' | 'adjust'>('credit');
  const [entryMeals, setEntryMeals] = useState('1');
  const [entryRupees, setEntryRupees] = useState('');
  const [entryDirection, setEntryDirection] = useState<'owes' | 'advance'>('owes');
  const [reason, setReason] = useState('');
  // refund
  const [refundMeals, setRefundMeals] = useState('');
  const [refundRupees, setRefundRupees] = useState('');
  const [refundValue, setRefundValue] = useState<{ meals: number; amount_paise: number } | null>(null);
  // void
  const [voiding, setVoiding] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState('');

  const paise = rupeesToPaise(amount);
  const autoMeals = !monthly && paise && p.unitPricePaise ? Math.floor(paise / p.unitPricePaise) : 0;
  const owedPaise = monthly ? Math.max(-p.balancePaise, 0) : 0;
  const owing = monthly ? p.balancePaise < 0 : p.balanceMeals < 0;

  function open(m: Mode) {
    setMode(m === mode ? null : m);
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
    if (err) {
      setError(friendlyError(err));
      return false;
    }
    setDone(message);
    setMode(null);
    router.refresh();
    return true;
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
      p_meals: !monthly && meals ? Number(meals) : undefined, p_receipt_photo_path: path,
      p_note: payNote.trim() || undefined, p_client_op: clientOp, p_paid_at: paidAtFor(paidOn, p.today),
    });
    setBusy(false);
    if (error) return setError(friendlyErrorIn('payment', error));
    setDone(`${formatPaise(paise)} recorded${paidOn !== p.today ? ` for ${day(`${paidOn}T12:00:00+05:30`)}` : ''}.`);
    setMode(null);
    setAmount('');
    setMeals('');
    setPayNote('');
    setPaidOn(p.today);
    setPhoto(null);
    setClientOp(newClientOp());
    router.refresh();
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
    setError('');
    const n = Number(entryMeals);
    if (monthly && entryType === 'adjust') {
      const r = rupeesToPaise(entryRupees);
      if (!r) return setError('Enter the amount in rupees.');
      setBusy(true);
      // Minus = the customer owes (opening dues, a correction); plus = already paid in advance.
      const signed = entryDirection === 'owes' ? -r : r;
      const { error } = await supabase.rpc('add_balance_entry', {
        p_customer: p.customerId, p_type: 'adjust', p_meals: 0, p_reason: reason, p_amount_paise: signed,
      });
      if (await finish(error, entryDirection === 'owes' ? `${formatPaise(r)} added to dues.` : `${formatPaise(r)} advance added.`)) {
        setReason('');
        setEntryRupees('');
      }
      return;
    }
    setBusy(true);
    const { error } = await supabase.rpc('add_balance_entry', { p_customer: p.customerId, p_type: entryType, p_meals: n, p_reason: reason });
    if (await finish(error, entryType === 'credit' ? `${n} free meal(s) added.` : 'Balance adjusted.')) setReason('');
  }

  async function refund() {
    setError('');
    let amountPaise: number | undefined;
    if (monthly && refundRupees.trim()) {
      const r = rupeesToPaise(refundRupees);
      if (!r) return setError('Enter the amount in rupees.');
      amountPaise = r;
    }
    setBusy(true);
    const { error } = await supabase.rpc('refund_unused_meals', monthly
      ? { p_customer: p.customerId, p_amount_paise: amountPaise }
      : { p_customer: p.customerId, p_meals: refundMeals ? Number(refundMeals) : undefined });
    if (await finish(error, 'Refund created. Pay it below.')) {
      setRefundMeals('');
      setRefundRupees('');
    }
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

  async function voidPayment(pay: Payment) {
    if (!voidReason.trim()) return setError(friendlyError({ message: 'reason_required' }));
    setBusy(true);
    setError('');
    const { error } = await supabase.rpc('void_payment', { p_payment: pay.id, p_reason: voidReason.trim() });
    if (await finish(error, `${formatPaise(pay.amount_paise)} payment voided. The balance is back to what it was before it.`)) {
      setVoiding(null);
      setVoidReason('');
    }
  }

  async function switchBilling() {
    setBusy(true);
    setError('');
    const next: BillingMode = monthly ? 'prepaid' : 'monthly';
    const { data, error } = await supabase.rpc('set_billing_mode', { p_customer: p.customerId, p_mode: next });
    if (error) return finish(error, '');
    const r = data as unknown as { balance_meals: number; balance_paise: number };
    await finish(null, `Now ${BILLING_LABEL[next].toLowerCase()}: ${balanceText(next, r.balance_meals, r.balance_paise)}.`);
  }

  const linkMessage = link
    ? `Namaskar ${p.customerName}, please pay ${formatPaise(link.amount)} for ${link.meals} meals at ${p.kitchenName}: ${link.url}`
    : '';

  return (
    <Card title="Money" actions={<LinkButton href={p.statementHref} variant="ghost">Statement</LinkButton>}>
      <div data-testid="money-balance">
        {monthly ? (
          <>
            <div className="flex items-baseline gap-2">
              <span className={`text-3xl font-semibold ${owing ? 'text-red-700' : ''}`}>{formatPaise(Math.abs(p.balancePaise))}</span>
              <span className="text-ink-500">{p.balancePaise < 0 ? 'due' : p.balancePaise > 0 ? 'advance' : 'settled'}</span>
            </div>
            <p className="text-sm text-ink-500">
              Monthly (pay later): meals go on the khata at their own price; collect at month end.
              {p.unitPricePaise ? ` · ${formatPaise(p.unitPricePaise)} per meal` : ''}
            </p>
          </>
        ) : (
          <>
            <div className="flex items-baseline gap-2">
              <span className={`text-3xl font-semibold ${p.balanceMeals < 0 ? 'text-red-700' : ''}`}>{p.balanceMeals}</span>
              <span className="text-ink-500">meals</span>
            </div>
            <p className="text-sm text-ink-500">
              Prepaid ·{' '}
              {p.balanceMeals < 0
                ? `Owes ${-p.balanceMeals} meal(s)${p.unitPricePaise ? ` · about ${formatPaise(-p.balanceMeals * p.unitPricePaise)}` : ''}`
                : `${formatPaise(p.valuePaise)} prepaid value`}
              {p.unitPricePaise ? ` · ${formatPaise(p.unitPricePaise)} per meal` : ''}
            </p>
          </>
        )}
      </div>

      {p.canWrite && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Button variant={mode === 'cash' ? 'primary' : 'secondary'} className="px-3 py-1" onClick={() => open('cash')}>Record payment</Button>
          {!monthly && <Button variant={mode === 'link' ? 'primary' : 'secondary'} className="px-3 py-1" onClick={() => open('link')}>Payment link</Button>}
          <Button variant={mode === 'entry' ? 'primary' : 'secondary'} className="px-3 py-1" onClick={() => open('entry')}>Credit / adjust</Button>
          <Button variant={mode === 'refund' ? 'primary' : 'secondary'} className="px-3 py-1" onClick={() => open('refund')}>Refund</Button>
          <Button variant={mode === 'billing' ? 'primary' : 'ghost'} className="px-3 py-1" onClick={() => open('billing')}>Billing: {monthly ? 'monthly' : 'prepaid'}</Button>
        </div>
      )}
      {done && <div className="mt-2"><Alert tone="green">{done}</Alert></div>}

      {mode === 'cash' && (
        <div className="mt-3 space-y-3 rounded-lg bg-ink-50 p-3 ring-1 ring-ink-200" data-testid="record-payment">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Amount (₹)"><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={owedPaise ? String(owedPaise / 100) : '1820'} autoFocus /></Field>
            <Field label="Method">
              <Select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
                <option value="cash">Cash</option>
                <option value="upi_manual">UPI to my number</option>
                <option value="bank_transfer">Bank transfer</option>
              </Select>
            </Field>
            {!monthly && (
              <Field label="Meals" hint={autoMeals ? `Default ${autoMeals} at ${formatPaise(p.unitPricePaise!)}/meal` : undefined}>
                <Input inputMode="numeric" value={meals} onChange={(e) => setMeals(e.target.value)} placeholder={autoMeals ? String(autoMeals) : ''} />
              </Field>
            )}
            <Field label="Paid on" hint={paidOn !== p.today ? 'Recorded as an earlier payment.' : undefined}>
              <Input type="date" value={paidOn} max={p.today} min={addDays(p.today, -400)} onChange={(e) => setPaidOn(e.target.value || p.today)} aria-label="Paid on" />
            </Field>
            <Field label="Note (optional)" className="col-span-2 sm:col-span-1">
              <Input value={payNote} onChange={(e) => setPayNote(e.target.value)} maxLength={200} placeholder="October dues" />
            </Field>
            <Field label="Receipt photo (optional)" className="col-span-2 sm:col-span-1">
              <input type="file" accept="image/*,application/pdf" capture="environment" className="w-full text-sm" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
            </Field>
          </div>
          {monthly && owedPaise > 0 && (
            <div className="flex flex-wrap gap-1.5 text-xs">
              <button type="button" className="rounded-full bg-white px-2.5 py-1 ring-1 ring-ink-200 hover:bg-brand-50" onClick={() => setAmount(String(owedPaise / 100))}>
                Full dues · {formatPaise(owedPaise)}
              </button>
            </div>
          )}
          {!monthly && p.unitPricePaise && (
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
          <p className="text-xs text-ink-500">Print a receipt from the payment list if the customer wants one.</p>
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
              <p className="text-xs text-ink-500">Razorpay test mode: no real money moves.</p>
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
                <option value="adjust">{monthly ? 'Opening dues / correction (₹)' : 'Opening balance / correction'}</option>
              </Select>
            </Field>
            {monthly && entryType === 'adjust' ? (
              <Field label="Amount (₹)"><Input inputMode="decimal" value={entryRupees} onChange={(e) => setEntryRupees(e.target.value)} placeholder="1200" /></Field>
            ) : (
              <Field label="Meals" hint={entryType === 'adjust' ? 'Use a negative number to reduce.' : monthly ? 'Taken off the dues at the meal’s price.' : undefined}>
                <Input inputMode="numeric" value={entryMeals} onChange={(e) => setEntryMeals(e.target.value)} />
              </Field>
            )}
            {monthly && entryType === 'adjust' && (
              <Field label="This amount is" className="col-span-2">
                <Select value={entryDirection} onChange={(e) => setEntryDirection(e.target.value as 'owes' | 'advance')}>
                  <option value="owes">Owed by the customer (adds to dues)</option>
                  <option value="advance">Already paid in advance (reduces dues)</option>
                </Select>
              </Field>
            )}
          </div>
          <Field label="Reason (kept in the audit log)"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={entryType === 'credit' ? 'Delivered 1 hour late' : monthly ? 'Dues from the October register' : 'Paid in October register'} /></Field>
          <Button onClick={addEntry} disabled={busy || !reason.trim() || (monthly && entryType === 'adjust' ? !rupeesToPaise(entryRupees) : !Number(entryMeals))}>{busy ? 'Saving…' : 'Save'}</Button>
        </div>
      )}

      {mode === 'refund' && (
        <div className="mt-3 space-y-3 rounded-lg bg-ink-50 p-3 ring-1 ring-ink-200">
          {refundValue && (monthly ? (
            <p className="text-sm">Advance paid: <strong>{formatPaise(refundValue.amount_paise)}</strong>{refundValue.amount_paise === 0 ? ' (nothing to refund).' : '.'}</p>
          ) : (
            <p className="text-sm">Unused: <strong>{refundValue.meals} meals</strong> worth <strong>{formatPaise(refundValue.amount_paise)}</strong> (valued at what the customer paid, oldest purchases used first).</p>
          ))}
          {monthly ? (
            <Field label="Amount to refund (₹, empty = all of the advance)"><Input inputMode="decimal" value={refundRupees} onChange={(e) => setRefundRupees(e.target.value)} /></Field>
          ) : (
            <Field label="Meals to refund (empty = all unused)"><Input inputMode="numeric" value={refundMeals} onChange={(e) => setRefundMeals(e.target.value)} /></Field>
          )}
          <Button onClick={refund} disabled={busy || !(monthly ? refundValue?.amount_paise : refundValue?.meals)}>{busy ? 'Saving…' : 'Create refund'}</Button>
        </div>
      )}

      {mode === 'billing' && (
        <div className="mt-3 space-y-3 rounded-lg bg-ink-50 p-3 text-sm ring-1 ring-ink-200" data-testid="billing-switch">
          <p>This customer is billed <strong>{BILLING_LABEL[p.billingMode].toLowerCase()}</strong>.</p>
          {monthly ? (
            <p className="text-ink-600">
              Prepaid customers pay before they eat; meals stop at your credit limit. Any advance becomes whole meals at
              {p.unitPricePaise ? ` ${formatPaise(p.unitPricePaise)}` : ' the plan price'} per meal; dues become meals owed.
            </p>
          ) : (
            <p className="text-ink-600">
              Monthly customers eat now and pay at month end; nothing stops automatically. Unused meals become an advance at what
              the customer paid; meals owed become rupee dues at their own prices.
            </p>
          )}
          <Button onClick={switchBilling} disabled={busy}>{busy ? 'Changing…' : monthly ? 'Change to prepaid' : 'Change to monthly (pay later)'}</Button>
        </div>
      )}
      {error && <div className="mt-2"><Alert>{error}</Alert></div>}

      {p.refunds.length > 0 && (
        <>
          <h3 className="mt-5 text-sm font-semibold">Refunds</h3>
          <ul className="divide-y divide-ink-100 text-sm">
            {p.refunds.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>{day(r.created_at)}{r.meals > 0 ? ` · ${r.meals} meals` : ''} · <strong>{formatPaise(r.amount_paise)}</strong></span>
                <span className="flex flex-wrap items-center gap-1.5">
                  <RefundStatus status={r.status} />
                  {p.canWrite && (r.status === 'pending' || r.status === 'failed') && (
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
      <ul className="divide-y divide-ink-100 text-sm" data-testid="payments">
        {p.payments.map((pay) => (
          <li key={pay.id} className="py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className={pay.status === 'voided' ? 'text-ink-500 line-through' : ''}>
                {day(pay.paid_at ?? pay.created_at)} · {METHOD_LABEL[pay.method] ?? pay.method} · <strong>{formatPaise(pay.amount_paise)}</strong>
                {pay.meals > 0 && <span className="text-ink-500"> ({pay.meals} meals)</span>}
              </span>
              <span className="flex flex-wrap items-center gap-1.5">
                <PaymentStatus status={pay.status} />
                {p.canWrite && pay.status === 'pending' && (
                  <>
                    <Button variant="secondary" className="px-2 py-0.5 text-xs" disabled={busy} onClick={() => confirmPending(pay, true)}>Confirm</Button>
                    <Button variant="ghost" className="px-2 py-0.5 text-xs" disabled={busy} onClick={() => confirmPending(pay, false)}>Not received</Button>
                  </>
                )}
                {pay.status === 'paid' && <a href={`/print/receipt/${pay.id}`} className="text-xs text-brand-700 hover:underline">Receipt</a>}
                {p.canWrite && pay.status === 'paid' && VOIDABLE.has(pay.method) && voiding !== pay.id && (
                  <button type="button" className="text-xs text-red-700 hover:underline" onClick={() => { setVoiding(pay.id); setVoidReason(''); setError(''); }}>Void</button>
                )}
                {p.canWrite && pay.status === 'created' && pay.short_url && (
                  <a href={whatsappUrl(p.customerPhone, `Namaskar ${p.customerName}, please pay ${formatPaise(pay.amount_paise)} for ${pay.meals} meals at ${p.kitchenName}: ${pay.short_url}`)}
                     target="_blank" rel="noreferrer" className="text-xs text-green-700 hover:underline">Resend</a>
                )}
              </span>
            </div>
            {pay.note && <div className="text-xs text-ink-500">{pay.note}</div>}
            {pay.status === 'voided' && pay.void_reason && <div className="text-xs text-ink-500">Voided: {pay.void_reason}</div>}
            {voiding === pay.id && (
              <div className="mt-2 flex flex-wrap items-end gap-2 rounded-lg bg-red-50 p-2 ring-1 ring-red-200" data-testid="void-form">
                <Field label="Why is this payment wrong?" className="min-w-48 flex-1">
                  <Input value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder="Entered twice / wrong customer" autoFocus />
                </Field>
                <Button variant="danger" disabled={busy || !voidReason.trim()} onClick={() => voidPayment(pay)}>Void {formatPaise(pay.amount_paise)}</Button>
                <Button variant="ghost" onClick={() => setVoiding(null)}>Keep</Button>
              </div>
            )}
          </li>
        ))}
        {p.payments.length === 0 && <li className="py-2 text-ink-500">No payments yet.</li>}
      </ul>
    </Card>
  );
}
