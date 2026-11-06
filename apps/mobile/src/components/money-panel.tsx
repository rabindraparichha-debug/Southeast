import { useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { formatPaise, formatServiceDate, isIsoDate, istDate, rupeesToPaise } from '@tiffin/core';
import type { BillingMode, MemberRole } from '@tiffin/db';
import { supabase } from '@/lib/supabase';
import { friendlyError } from '@/lib/errors';
import { isLead } from '@/lib/roles';
import {
  MANUAL_METHODS, balanceText, billingLabel, friendlyErrorFor, isFullPhone, methodLabel, monthLabel, monthStart, newClientOp,
  owes, paidAtFor, recentDays, type ManualMethod, type PaymentRow, type StatementSummary,
} from '@/lib/money';
import { t } from '@/i18n';
import { Button, Card, Chip, ErrorText, Input, Label, Muted } from './ui';
import { colors, radius, space } from './theme';

type Props = {
  customerId: string;
  kitchenId: string;
  kitchenName: string;
  role: MemberRole;
  name: string;
  phone: string | null;
  billingMode: BillingMode;
  /** Bump to reload (e.g. after a schedule change). */
  version?: unknown;
  /** Called after a change the parent shows too (billing mode). */
  onChanged: () => void;
};
type Panel = 'pay' | 'switch' | null;

/**
 * Money on the customer page (D-115). Monthly (pay later) customers: rupee dues or advance, payments
 * in rupees, a month statement to share. Prepaid: meal balance, payments buy meals. Owners and
 * managers record any amount by cash, UPI or bank (with a date for late entries), void a wrong
 * payment with a reason, confirm or reject cash a rider collected, and switch the billing mode.
 * Accountants see the same numbers, read-only.
 */
export function MoneyPanel(p: Props) {
  const lead = isLead(p.role);
  const today = istDate();
  const [balance, setBalance] = useState<{ meals: number; paise: number }>({ meals: 0, paise: 0 });
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [prices, setPrices] = useState<number[]>([]);
  const [statement, setStatement] = useState<StatementSummary | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<{ url: string; amount: number; meals: number } | null>(null);
  const [reload, setReload] = useState(0);

  const { customerId } = p;
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [b, pays, subs, st] = await Promise.all([
        supabase.from('customer_balances').select('meals, amount_paise').eq('customer_id', customerId).maybeSingle(),
        supabase.from('payments')
          .select('id, method, status, amount_paise, meals, paid_at, created_at, note, void_reason, collected_by')
          .eq('customer_id', customerId).order('created_at', { ascending: false }).limit(15),
        supabase.from('subscriptions').select('plan:plans(price_per_meal_paise)').eq('customer_id', customerId).neq('status', 'cancelled'),
        supabase.rpc('customer_statement', { p_customer: customerId, p_month: monthStart(istDate()) }),
      ]);
      if (!alive) return;
      setBalance({ meals: b.data?.meals ?? 0, paise: b.data?.amount_paise ?? 0 });
      setPayments((pays.data ?? []) as PaymentRow[]);
      setPrices(((subs.data ?? []) as { plan: { price_per_meal_paise: number } | null }[])
        .map((s) => s.plan?.price_per_meal_paise ?? 0).filter((n) => n > 0));
      setStatement((st.data as unknown as StatementSummary | null) ?? null);
    })();
    return () => {
      alive = false;
    };
  }, [customerId, p.version, p.billingMode, reload]);

  const done = (message: string) => {
    setError('');
    setSaved(message);
    setPanel(null);
    setReload((n) => n + 1);
  };

  const monthly = p.billingMode === 'monthly';
  const owing = owes(p.billingMode, balance.meals, balance.paise);
  const price = prices[0] ?? null;
  const canShare = lead && monthly && isFullPhone(p.phone) && statement !== null;

  async function sendLink(meals: number) {
    setBusy(true);
    setError('');
    const { data, error } = await supabase.functions.invoke('razorpay-payment-link', { body: { customer_id: p.customerId, meals } });
    setBusy(false);
    if (error) {
      const body = await (error as { context?: Response }).context?.json?.().catch(() => null);
      return setError(friendlyError({ message: body?.error ?? error.message }));
    }
    const res = data as { short_url: string; amount_paise: number; meals: number };
    setLink({ url: res.short_url, amount: res.amount_paise, meals: res.meals });
  }

  function shareStatement() {
    if (!statement || !isFullPhone(p.phone)) return;
    const text = t('money.statementMessage', {
      name: p.name, month: monthLabel(statement.month), kitchen: p.kitchenName,
      meals: statement.totals.meals_charged, charged: formatPaise(statement.totals.charged_paise),
      paid: formatPaise(statement.totals.paid_paise), due: formatPaise(statement.amount_due_paise),
    });
    void Linking.openURL(`https://wa.me/${p.phone.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`);
  }

  return (
    <Card>
      <View style={styles.head}>
        <Label>{t('money.title')}</Label>
        <Text style={[styles.badge, monthly ? styles.badgeMonthly : styles.badgePrepaid]}>{billingLabel(p.billingMode)}</Text>
      </View>
      <Text style={[styles.balance, owing && { color: colors.danger }]} testID="balance">
        {balanceText(p.billingMode, balance.meals, balance.paise)}
      </Text>

      {statement && (
        <View style={styles.month}>
          <Text style={styles.monthTitle}>{monthLabel(statement.month)}</Text>
          <Muted>
            {t('money.monthLine', {
              meals: statement.totals.meals_charged,
              charged: formatPaise(statement.totals.charged_paise),
              paid: formatPaise(statement.totals.paid_paise),
            })}
          </Muted>
          {statement.totals.voided_paise > 0 && <Muted>{t('money.monthVoided', { amount: formatPaise(statement.totals.voided_paise) })}</Muted>}
          {monthly && (
            <Text style={styles.due}>
              {statement.amount_due_paise > 0 ? t('money.dueNow', { amount: formatPaise(statement.amount_due_paise) }) : t('money.nothingDue')}
            </Text>
          )}
        </View>
      )}

      {lead && panel === null && !link && (
        <View style={styles.chips}>
          <Chip label={`+ ${t('money.recordPayment')}`} selected={false} onPress={() => { setSaved(''); setPanel('pay'); }} />
          {!monthly && price ? <Chip label={t('money.link', { meals: 26 })} selected={false} onPress={() => sendLink(26)} /> : null}
          {canShare && <Chip label={t('money.shareStatement')} selected={false} onPress={shareStatement} />}
          <Chip label={monthly ? t('billing.toPrepaid') : t('billing.toMonthly')} selected={false} onPress={() => { setSaved(''); setPanel('switch'); }} />
        </View>
      )}

      {panel === 'pay' && (
        <PaymentForm
          customerId={p.customerId}
          monthly={monthly}
          duePaise={monthly ? Math.max(-balance.paise, 0) : 0}
          price={price}
          today={today}
          onCancel={() => setPanel(null)}
          onSaved={(text) => done(text)}
        />
      )}

      {panel === 'switch' && (
        <SwitchBilling customerId={p.customerId} current={p.billingMode} onCancel={() => setPanel(null)}
          onSaved={(text) => { done(text); p.onChanged(); }} />
      )}

      {link && (
        <View style={styles.confirm}>
          <Text style={styles.confirmTitle}>{t('money.linkReady', { amount: formatPaise(link.amount) })}</Text>
          <Muted>{link.url}</Muted>
          {isFullPhone(p.phone) && (
            <Button
              title={t('money.openWhatsapp')}
              onPress={() =>
                Linking.openURL(`https://wa.me/${(p.phone ?? '').replace(/\D/g, '')}?text=${encodeURIComponent(
                  t('money.linkMessage', { name: p.name, amount: formatPaise(link.amount), meals: link.meals, kitchen: p.kitchenName, url: link.url }))}`)
              }
            />
          )}
          <Button title={t('actions.back')} onPress={() => setLink(null)} variant="secondary" />
        </View>
      )}

      {saved ? <Text style={styles.saved}>✓ {saved}</Text> : null}
      <ErrorText>{error}</ErrorText>
      {busy && <Muted>{t('customer.saving')}</Muted>}

      <Label>{t('money.payments')}</Label>
      {payments.length === 0 && <Muted>{t('money.noPayments')}</Muted>}
      {payments.map((pay) => (
        <PaymentLine key={pay.id} pay={pay} monthly={monthly} lead={lead} onDone={done} />
      ))}
    </Card>
  );
}

/** Any amount by cash, UPI or bank, for today or an earlier day. One idempotency key per form. */
function PaymentForm({ customerId, monthly, duePaise, price, today, onCancel, onSaved }: {
  customerId: string; monthly: boolean; duePaise: number; price: number | null; today: string;
  onCancel: () => void; onSaved: (text: string) => void;
}) {
  const [method, setMethod] = useState<ManualMethod>('cash');
  const [amount, setAmount] = useState(duePaise > 0 ? String(duePaise / 100) : '');
  const [meals, setMeals] = useState('');
  const [day, setDay] = useState(today);
  const [otherDay, setOtherDay] = useState('');
  const [showOther, setShowOther] = useState(false);
  const [note, setNote] = useState('');
  const [clientOp] = useState(newClientOp); // reused by every retry of this form
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const paise = rupeesToPaise(amount.trim());
  const mealsN = meals.trim() ? Number(meals.trim()) : null;
  const guessMeals = !monthly && price && paise ? Math.floor(paise / price) : null;
  const paidOn = showOther ? otherDay.trim() : day;

  async function save() {
    setError('');
    if (!paise || paise <= 0) return setError(t('errors.invalid_amount'));
    if (!monthly && mealsN !== null && (!Number.isInteger(mealsN) || mealsN <= 0)) return setError(t('errors.invalid_meals'));
    if (!isIsoDate(paidOn) || paidOn > today) return setError(t('errors.invalid_paid_at'));
    setBusy(true);
    const { error: e } = await supabase.rpc('record_payment', {
      p_customer: customerId, p_amount_paise: paise, p_method: method,
      p_meals: monthly ? undefined : mealsN ?? undefined,
      p_note: note.trim() || undefined, p_client_op: clientOp, p_paid_at: paidAtFor(paidOn, today),
    });
    setBusy(false);
    if (e) return setError(friendlyErrorFor(e, 'payment'));
    onSaved(paidOn === today
      ? t('money.recordedAmount', { amount: formatPaise(paise), method: methodLabel(method) })
      : t('money.recordedOn', { amount: formatPaise(paise), method: methodLabel(method), date: formatServiceDate(paidOn) }));
  }

  return (
    <View style={styles.confirm}>
      <Text style={styles.confirmTitle}>{t('money.recordPayment')}</Text>
      <View style={styles.chips}>
        {MANUAL_METHODS.map((m) => <Chip key={m} label={methodLabel(m)} selected={method === m} onPress={() => setMethod(m)} />)}
      </View>
      <Label>{t('money.amount')}</Label>
      <Input value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0" testID="pay-amount" />
      <View style={styles.chips}>
        {monthly && duePaise > 0 && (
          <Chip label={t('money.fullDues', { amount: formatPaise(duePaise) })} selected={paise === duePaise} onPress={() => setAmount(String(duePaise / 100))} />
        )}
        {!monthly && price ? [10, 26, 30].map((n) => (
          <Chip key={n} label={t('money.mealsFor', { meals: n, amount: formatPaise(n * price) })} selected={mealsN === n && paise === n * price}
            onPress={() => { setAmount(String((n * price) / 100)); setMeals(String(n)); }} />
        )) : null}
      </View>
      {!monthly && (
        <>
          <Label>{t('money.mealsBought')}</Label>
          <Input value={meals} onChangeText={setMeals} keyboardType="number-pad" placeholder={guessMeals ? String(guessMeals) : ''} />
          {mealsN === null && guessMeals !== null && <Muted>{t('money.mealsGuess', { n: guessMeals })}</Muted>}
        </>
      )}
      {monthly && <Muted>{t('money.monthlyRupees')}</Muted>}
      <Label>{t('money.paidOn')}</Label>
      <View style={styles.chips}>
        {recentDays(today, 4).map((d, i) => (
          <Chip key={d} label={i === 0 ? t('stock.purchase.today') : i === 1 ? t('stock.purchase.yesterday') : formatServiceDate(d)}
            selected={!showOther && day === d} onPress={() => { setShowOther(false); setDay(d); }} />
        ))}
        <Chip label={t('money.earlier')} selected={showOther} onPress={() => setShowOther(true)} />
      </View>
      {showOther && <Input value={otherDay} onChangeText={setOtherDay} placeholder="YYYY-MM-DD" autoCapitalize="none" />}
      <Label>{t('money.note')}</Label>
      <Input value={note} onChangeText={setNote} placeholder={t('money.notePlaceholder')} />
      <ErrorText>{error}</ErrorText>
      <Button
        title={paise ? t('money.saveAmount', { amount: formatPaise(paise), method: methodLabel(method) }) : t('money.save')}
        onPress={save} busy={busy} disabled={!paise}
      />
      <Button title={t('actions.back')} onPress={onCancel} variant="secondary" />
    </View>
  );
}

/** Monthly ↔ prepaid, with what happens to the balance spelled out first. */
function SwitchBilling({ customerId, current, onCancel, onSaved }: {
  customerId: string; current: BillingMode; onCancel: () => void; onSaved: (text: string) => void;
}) {
  const next: BillingMode = current === 'monthly' ? 'prepaid' : 'monthly';
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError('');
    const { data, error: e } = await supabase.rpc('set_billing_mode', { p_customer: customerId, p_mode: next });
    setBusy(false);
    if (e) return setError(friendlyError(e));
    const r = data as unknown as { billing_mode: BillingMode; balance_meals: number; balance_paise: number };
    onSaved(t('billing.changed', { mode: billingLabel(r.billing_mode), balance: balanceText(r.billing_mode, r.balance_meals, r.balance_paise) }));
  }

  return (
    <View style={styles.confirm}>
      <Text style={styles.confirmTitle}>{next === 'prepaid' ? t('billing.toPrepaid') : t('billing.toMonthly')}</Text>
      <Muted>{next === 'prepaid' ? t('billing.toPrepaidHint') : t('billing.toMonthlyHint')}</Muted>
      <ErrorText>{error}</ErrorText>
      <Button title={t('actions.confirm')} onPress={save} busy={busy} />
      <Button title={t('actions.back')} onPress={onCancel} variant="secondary" />
    </View>
  );
}

/** One payment: void (paid cash/UPI/bank) or confirm/reject (cash a rider collected). */
function PaymentLine({ pay, monthly, lead, onDone }: { pay: PaymentRow; monthly: boolean; lead: boolean; onDone: (text: string) => void }) {
  const [mode, setMode] = useState<'void' | 'reject' | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const voidable = lead && pay.status === 'paid' && (MANUAL_METHODS as readonly string[]).includes(pay.method);
  const pending = pay.status === 'pending';

  async function run(call: () => PromiseLike<{ error: { message?: string; code?: string } | null }>, text: string) {
    setBusy(true);
    setError('');
    const { error: e } = await call();
    setBusy(false);
    if (e) return setError(friendlyError(e));
    setMode(null);
    onDone(text);
  }

  const voidIt = () => {
    if (!reason.trim()) return setError(t('errors.reason_required'));
    void run(() => supabase.rpc('void_payment', { p_payment: pay.id, p_reason: reason.trim() }), t('money.voided', { amount: formatPaise(pay.amount_paise) }));
  };
  const confirmIt = () => run(() => supabase.rpc('confirm_payment', { p_payment: pay.id }), t('money.cashConfirmed', { amount: formatPaise(pay.amount_paise) }));
  const rejectIt = () =>
    run(() => supabase.rpc('reject_payment', { p_payment: pay.id, p_reason: reason.trim() || t('money.notReceived') }), t('money.cashRejected'));

  const at = pay.paid_at ?? pay.created_at;
  return (
    <View style={styles.pay}>
      <View style={styles.payRow}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.payAmount, (pay.status === 'voided' || pay.status === 'cancelled') && styles.struck]}>
            {formatPaise(pay.amount_paise)} · {methodLabel(pay.method)}{!monthly && pay.meals > 0 ? ` · ${t('balance.meals', { n: pay.meals })}` : ''}
          </Text>
          <Muted>{formatServiceDate(istDate(new Date(at)))}{pay.note ? ` · ${pay.note}` : ''}</Muted>
          {pay.status === 'voided' && pay.void_reason ? <Muted>{t('money.voidReason', { reason: pay.void_reason })}</Muted> : null}
        </View>
        <Text style={[styles.status, pending && { color: colors.jain }, pay.status === 'paid' && { color: colors.veg }]}>
          {pending && pay.collected_by ? t('money.status.riderCash') : t(`money.status.${pay.status}`)}
        </Text>
      </View>
      {lead && pending && mode === null && (
        <View style={styles.chips}>
          <Chip label={`✓ ${t('money.confirmCash')}`} selected={false} onPress={confirmIt} />
          <Chip label={t('money.rejectCash')} selected={false} onPress={() => { setReason(''); setMode('reject'); }} />
        </View>
      )}
      {voidable && mode === null && (
        <Pressable onPress={() => { setReason(''); setMode('void'); }}><Text style={styles.link}>{t('money.void')}</Text></Pressable>
      )}
      {mode && (
        <View style={styles.confirm}>
          <Label>{mode === 'void' ? t('money.voidWhy') : t('money.rejectWhy')}</Label>
          <Input value={reason} onChangeText={setReason} placeholder={mode === 'void' ? t('money.voidPlaceholder') : t('money.notReceived')} />
          {mode === 'void' && <Muted>{t('money.voidHint')}</Muted>}
          <ErrorText>{error}</ErrorText>
          <Button title={mode === 'void' ? t('money.voidConfirm') : t('money.rejectCash')} onPress={mode === 'void' ? voidIt : rejectIt} busy={busy} />
          <Button title={t('actions.back')} onPress={() => setMode(null)} variant="secondary" />
        </View>
      )}
      {!mode && error ? <ErrorText>{error}</ErrorText> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  badge: { fontSize: 12, fontWeight: '600', paddingHorizontal: space(2), paddingVertical: 2, borderRadius: 999, overflow: 'hidden' },
  badgeMonthly: { backgroundColor: '#DBEAFE', color: '#1D4ED8' },
  badgePrepaid: { backgroundColor: colors.line, color: colors.inkSoft },
  balance: { fontSize: 22, fontWeight: '700', color: colors.ink },
  month: { gap: 2, paddingVertical: space(2), borderTopWidth: 1, borderTopColor: colors.line },
  monthTitle: { fontSize: 14, fontWeight: '600', color: colors.inkSoft },
  due: { fontSize: 15, fontWeight: '600', color: colors.ink },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  confirm: { gap: space(2), backgroundColor: colors.brandSoft, padding: space(3), borderRadius: radius },
  confirmTitle: { fontSize: 16, fontWeight: '600', color: colors.ink },
  saved: { color: colors.veg, fontWeight: '600' },
  pay: { gap: space(1), paddingVertical: space(2), borderTopWidth: 1, borderTopColor: colors.line },
  payRow: { flexDirection: 'row', gap: space(2), alignItems: 'flex-start' },
  payAmount: { fontSize: 15, fontWeight: '600', color: colors.ink },
  struck: { textDecorationLine: 'line-through', color: colors.muted },
  status: { fontSize: 13, fontWeight: '600', color: colors.muted },
  link: { color: colors.danger, textDecorationLine: 'underline', paddingVertical: space(1) },
});
