import { useCallback, useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { SLOT_LABEL, addDays, formatPaise, formatPhone, formatServiceDate, istDate } from '@tiffin/core';
import type { ChangeResult, ChangeType, MealSlot, View as DbView } from '@tiffin/db';
import { supabase } from '@/lib/supabase';
import { useKitchen } from '@/lib/session';
import { friendlyError } from '@/lib/errors';
import { Button, Card, Chip, DIET_COLOR, DIET_LABEL, ErrorText, Label, Muted } from '@/components/ui';
import { CustomerExtras } from '@/components/customer-extras';
import { colors, radius, space } from '@/components/theme';
import { t } from '@/i18n';

type Meal = { id: string; subscription_id: string; service_date: string; slot: MealSlot; qty: number; status: string; charged: boolean; skip_reason: string | null; locked_at: string | null };
type Sub = { id: string; status: string; plan: { name: string; price_per_meal_paise: number } | null };
type Pending = { label: string; type: ChangeType; subscriptionId: string; from: string; to?: string; slot?: MealSlot; preview: ChangeResult };
type CashProposal = { meals: number; amount: number };

export default function CustomerDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const kitchen = useKitchen();
  const isOwner = kitchen.role === 'owner';
  const [c, setC] = useState<DbView<'customers_v'> | null>(null);
  const [meals, setMeals] = useState<Meal[]>([]);
  const [subs, setSubs] = useState<Sub[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [cash, setCash] = useState<CashProposal | null>(null);
  const [link, setLink] = useState<{ url: string; amount: number; meals: number } | null>(null);
  const today = istDate();

  const load = useCallback(async () => {
    const [cust, orders, s, b] = await Promise.all([
      supabase.from('customers_v').select('*').eq('id', id).eq('kitchen_id', kitchen.kitchenId).maybeSingle(),
      supabase.from('meal_orders').select('id, subscription_id, service_date, slot, qty, status, charged, skip_reason, locked_at')
        .eq('customer_id', id).gte('service_date', today).lte('service_date', addDays(today, 7)).order('service_date').order('slot'),
      isOwner ? supabase.from('subscriptions').select('id, status, plan:plans(name, price_per_meal_paise)').eq('customer_id', id).in('status', ['active', 'low_balance', 'paused', 'suspended', 'trial'])
              : Promise.resolve({ data: [] }),
      isOwner ? supabase.from('customer_balances').select('meals').eq('customer_id', id).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    setC(cust.data);
    setMeals((orders.data ?? []) as Meal[]);
    setSubs((s.data ?? []) as Sub[]);
    setBalance((b.data as { meals: number } | null)?.meals ?? null);
  }, [id, kitchen.kitchenId, isOwner, today]);

  useFocusEffect(useCallback(() => void load(), [load]));

  async function propose(label: string, type: ChangeType, subscriptionId: string, from: string, to?: string, slot?: MealSlot) {
    setError('');
    setSaved('');
    setBusy(true);
    const { data, error } = await supabase.rpc('request_schedule_change', {
      p_subscription: subscriptionId, p_type: type, p_from: from, p_to: to, p_slot: slot, p_dry_run: true,
    });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    setPending({ label, type, subscriptionId, from, to, slot, preview: data as unknown as ChangeResult });
  }

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    const { error } = await supabase.rpc('request_schedule_change', {
      p_subscription: pending.subscriptionId, p_type: pending.type, p_from: pending.from, p_to: pending.to, p_slot: pending.slot,
    });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    setSaved(`${pending.label} · ${t('actions.saved')}`);
    setPending(null);
    await load();
  }

  async function recordCash() {
    if (!cash) return;
    setBusy(true);
    setError('');
    const { error } = await supabase.rpc('record_payment', { p_customer: id, p_amount_paise: cash.amount, p_method: 'cash', p_meals: cash.meals });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    setSaved(t('money.recorded'));
    setCash(null);
    await load();
  }

  async function sendLink(meals: number) {
    setBusy(true);
    setError('');
    const { data, error } = await supabase.functions.invoke('razorpay-payment-link', { body: { customer_id: id, meals } });
    setBusy(false);
    if (error) {
      const body = await (error as { context?: Response }).context?.json?.().catch(() => null);
      return setError(friendlyError({ message: body?.error ?? error.message }));
    }
    const res = data as { short_url: string; amount_paise: number; meals: number };
    setLink({ url: res.short_url, amount: res.amount_paise, meals: res.meals });
  }

  if (!c) return null;
  const canCall = isOwner && c.phone && !c.phone.includes('•');
  const price = subs[0]?.plan?.price_per_meal_paise ?? null;

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: c.name ?? '' }} />
      <Card>
        <Text style={styles.name}>{c.name}</Text>
        <Muted>{formatPhone(c.phone)}</Muted>
        <Text style={{ fontSize: 14 }}>
          {c.diet && <Text style={{ color: DIET_COLOR[c.diet], fontWeight: '600' }}>{DIET_LABEL[c.diet]}</Text>}
          {balance !== null && <Text style={{ color: colors.inkSoft }}>  ·  {t('balance.meals', { n: balance })}</Text>}
        </Text>
        <Muted>{[c.line1, c.landmark, c.area].filter(Boolean).join(', ')}</Muted>
        {canCall && <Button title={`📞 ${t('customer.call')}`} onPress={() => Linking.openURL(`tel:${c.phone}`)} variant="secondary" />}
      </Card>

      {isOwner && price && (
        <Card>
          <Label>{t('money.title')}{balance !== null && balance < 0 ? ` · ${t('money.owes', { n: -balance })}` : ''}</Label>
          {!cash && !link && (
            <View style={styles.chips}>
              {[10, 26, 30].map((n) => (
                <Chip key={n} label={t('money.cash', { meals: n, amount: formatPaise(n * price) })} selected={false} onPress={() => setCash({ meals: n, amount: n * price })} />
              ))}
              <Chip label={t('money.link', { meals: 26 })} selected={false} onPress={() => sendLink(26)} />
            </View>
          )}
          {cash && (
            <View style={styles.confirm}>
              <Text style={styles.confirmTitle}>{t('money.recordCash', { amount: formatPaise(cash.amount), meals: cash.meals })}</Text>
              <Button title={t('actions.confirm')} onPress={recordCash} busy={busy} />
              <Button title={t('actions.back')} onPress={() => setCash(null)} variant="secondary" />
            </View>
          )}
          {link && (
            <View style={styles.confirm}>
              <Text style={styles.confirmTitle}>{t('money.linkReady', { amount: formatPaise(link.amount) })}</Text>
              <Muted>{link.url}</Muted>
              <Button
                title={t('money.openWhatsapp')}
                onPress={() =>
                  Linking.openURL(`https://wa.me/${(c.phone ?? '').replace(/\D/g, '')}?text=${encodeURIComponent(
                    t('money.linkMessage', { name: c.name ?? '', amount: formatPaise(link.amount), meals: link.meals, kitchen: kitchen.kitchenName, url: link.url }))}`)
                }
              />
              <Button title={t('actions.back')} onPress={() => setLink(null)} variant="secondary" />
            </View>
          )}
        </Card>
      )}

      {isOwner && subs.filter((s) => s.status !== 'trial' && s.status !== 'suspended').map((s) => {
        const mine = meals.filter((m) => m.subscription_id === s.id);
        const next = mine.find((m) => m.status === 'scheduled' && !m.locked_at);
        const openDays = [...new Set(mine.filter((m) => !m.locked_at && m.status === 'scheduled').map((m) => m.service_date))].slice(0, 2);
        const firstPaused = mine.find((m) => m.status === 'skipped' && !m.locked_at);
        const from = next?.service_date ?? addDays(today, 1);
        return (
          <Card key={s.id}>
            <Label>{t('actions.title')} · {s.plan?.name}</Label>
            {!pending && (
              <View style={styles.chips}>
                {next && <Chip label={t('actions.skipNext')} selected={false} onPress={() => propose(t('actions.skipNext'), 'skip', s.id, next.service_date, next.service_date, next.slot)} />}
                {openDays.map((d) => (
                  <Chip key={d} label={t('actions.skipDay', { date: formatServiceDate(d) })} selected={false} onPress={() => propose(t('actions.skipDay', { date: formatServiceDate(d) }), 'skip', s.id, d, d)} />
                ))}
                {s.status !== 'paused' && (
                  <>
                    <Chip label={t('actions.pause3')} selected={false} onPress={() => propose(t('actions.pause3'), 'pause', s.id, from, addDays(from, 2))} />
                    <Chip label={t('actions.pause7')} selected={false} onPress={() => propose(t('actions.pause7'), 'pause', s.id, from, addDays(from, 6))} />
                    <Chip label={t('actions.pauseOpen')} selected={false} onPress={() => propose(t('actions.pauseOpen'), 'pause', s.id, from)} />
                  </>
                )}
                {firstPaused && (
                  <Chip label={t('actions.resume')} selected={false} onPress={() => propose(t('actions.resume'), 'resume', s.id, firstPaused.service_date)} />
                )}
              </View>
            )}
            {pending?.subscriptionId === s.id && (
              <View style={styles.confirm}>
                <Text style={styles.confirmTitle}>{pending.label}</Text>
                <Muted>
                  {pending.preview.affected.length
                    ? t('actions.affects', { meals: pending.preview.affected.slice(0, 4).map((a) => `${formatServiceDate(a.date)} ${SLOT_LABEL[a.slot]}`).join(', ') + (pending.preview.affected.length > 4 ? '…' : '') })
                    : t('actions.noneAffected')}
                </Muted>
                {pending.preview.affected.some((a) => a.charged) && (
                  <Text style={styles.warn}>{t('actions.charged', { n: pending.preview.affected.filter((a) => a.charged).length })}</Text>
                )}
                <Button title={t('actions.confirm')} onPress={confirm} busy={busy} />
                <Button title={t('actions.back')} onPress={() => setPending(null)} variant="secondary" />
              </View>
            )}
          </Card>
        );
      })}
      {saved ? <Text style={styles.saved}>✓ {saved}</Text> : null}
      <ErrorText>{error}</ErrorText>

      <Card>
        <Label>{t('meals.title')}</Label>
        {meals.length === 0 && <Muted>{t('meals.none')}</Muted>}
        {meals.map((m) => (
          <View key={m.id} style={styles.meal}>
            <Text style={styles.mealDate}>{formatServiceDate(m.service_date)} · {SLOT_LABEL[m.slot]}{m.qty > 1 ? ` ×${m.qty}` : ''}</Text>
            <Text style={[styles.mealStatus, m.status === 'skipped' && { color: m.charged ? '#B45309' : colors.muted }]}>
              {m.status === 'skipped'
                ? m.charged ? t('meals.lateSkip') : m.skip_reason === 'pause' ? t('meals.paused') : t('meals.skipped')
                : m.locked_at ? t('meals.locked') : t('meals.scheduled')}
            </Text>
          </View>
        ))}
      </Card>

      {kitchen.role !== 'rider' && <CustomerExtras customerId={id} kitchenId={kitchen.kitchenId} isOwner={isOwner} />}

      {c.notes ? (
        <Card>
          <Label>{t('customer.notes')}</Label>
          <Text style={{ color: colors.inkSoft }}>{c.notes}</Text>
        </Card>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space(4), gap: space(3) },
  name: { fontSize: 20, fontWeight: '600', color: colors.ink },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  confirm: { gap: space(2), backgroundColor: colors.brandSoft, padding: space(3), borderRadius: radius },
  confirmTitle: { fontSize: 16, fontWeight: '600', color: colors.ink },
  warn: { color: '#B45309', fontWeight: '600' },
  saved: { color: colors.veg, fontWeight: '600' },
  meal: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: space(2), borderTopWidth: 1, borderTopColor: colors.line },
  mealDate: { color: colors.inkSoft },
  mealStatus: { color: colors.veg, fontWeight: '500' },
});
