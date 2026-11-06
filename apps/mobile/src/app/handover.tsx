// Cash and credits (audit item 25).
// Owners: approve or refuse meal credits riders asked for (kitchen-fault failures), and confirm the
// cash each rider hands over in one tap. Everyone else: the cash they collected and still hold.
import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SLOT_LABEL, formatPaise, formatServiceDate } from '@tiffin/core';
import type { MealSlot } from '@tiffin/db';
import { Button, Card, ErrorText, Muted } from '@/components/ui';
import { colors, space } from '@/components/theme';
import { friendlyError } from '@/lib/errors';
import { useKitchen } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { t } from '@/i18n';

type Credit = {
  stop_id: string; customer_name: string; service_date: string; slot: MealSlot; reason: string; note: string | null;
  rider_name: string | null; meals: number; amount_paise: number;
};
type Collector = {
  user_id: string; name: string; pending_count: number; pending_paise: number; confirmed_paise: number;
  pending: { payment_id: string; customer_name: string; amount_paise: number }[];
};
type Mine = { kitchen_id: string; kitchen_name: string; pending_count: number; pending_paise: number; confirmed_paise: number;
  pending: { payment_id: string; customer_name: string; amount_paise: number }[] };

export default function Handover() {
  const kitchen = useKitchen();
  const isOwner = kitchen.role === 'owner';
  const [credits, setCredits] = useState<Credit[]>([]);
  const [collectors, setCollectors] = useState<Collector[]>([]);
  const [mine, setMine] = useState<Mine[]>([]);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const own = await supabase.rpc('my_cash_handover');
    setMine(((own.data ?? []) as unknown as Mine[]).filter((m) => m.kitchen_id === kitchen.kitchenId));
    if (!isOwner) return;
    const [c, h] = await Promise.all([
      supabase.rpc('stop_credit_requests', { p_kitchen: kitchen.kitchenId }),
      supabase.rpc('cash_handover', { p_kitchen: kitchen.kitchenId }),
    ]);
    if (c.error || h.error) setError(friendlyError(c.error ?? h.error));
    setCredits((c.data ?? []) as unknown as Credit[]);
    setCollectors((((h.data ?? {}) as unknown as { collectors?: Collector[] }).collectors ?? []).filter((x) => x.pending_count > 0));
  }, [kitchen.kitchenId, isOwner]);

  useFocusEffect(useCallback(() => void load(), [load]));

  const decide = async (stop: string, approve: boolean) => {
    setBusy(stop);
    setError('');
    const { error: e } = await supabase.rpc('decide_stop_credit', { p_stop: stop, p_approve: approve });
    setBusy(null);
    if (e) setError(friendlyError(e));
    await load();
  };

  const confirm = async (c: Collector) => {
    setBusy(c.user_id);
    setError('');
    const { data, error: e } = await supabase.rpc('confirm_rider_cash', {
      p_kitchen: kitchen.kitchenId, p_rider: c.user_id, p_payment_ids: c.pending.map((p) => p.payment_id),
    });
    setBusy(null);
    if (e) setError(friendlyError(e));
    else setInfo(t('handover.confirmed', { amount: formatPaise(Number((data as { paise?: number } | null)?.paise ?? 0)) }));
    await load();
  };

  return (
    <ScrollView
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
    >
      <Stack.Screen options={{ title: t('handover.title') }} />
      <ErrorText>{error}</ErrorText>
      {info ? <Muted>{info}</Muted> : null}

      {isOwner && (
        <Card>
          <Text style={styles.h}>{t('handover.credits')}</Text>
          {credits.length === 0 && <Muted>{t('handover.noCredits')}</Muted>}
          {credits.map((c) => (
            <View key={c.stop_id} style={styles.item}>
              <Text style={styles.name}>{c.customer_name} · {formatServiceDate(c.service_date)} {SLOT_LABEL[c.slot]}</Text>
              <Muted>{t('handover.creditLine', { rider: c.rider_name ?? '—', reason: t(`rider.reason.${c.reason}`), meals: c.meals,
                amount: formatPaise(c.amount_paise) })}</Muted>
              {c.note ? <Muted>“{c.note}”</Muted> : null}
              <View style={styles.row}>
                <View style={{ flex: 1 }}><Button title={t('handover.approve')} onPress={() => decide(c.stop_id, true)} busy={busy === c.stop_id} /></View>
                <View style={{ flex: 1 }}><Button title={t('handover.reject')} variant="secondary" onPress={() => decide(c.stop_id, false)} disabled={busy === c.stop_id} /></View>
              </View>
            </View>
          ))}
        </Card>
      )}

      {isOwner && (
        <Card>
          <Text style={styles.h}>{t('handover.cash')}</Text>
          {collectors.length === 0 && <Muted>{t('handover.noCash')}</Muted>}
          {collectors.map((c) => (
            <View key={c.user_id} style={styles.item}>
              <Text style={styles.name}>{t('handover.collector', { name: c.name, amount: formatPaise(c.pending_paise), n: c.pending_count })}</Text>
              {c.pending.map((p) => <Muted key={p.payment_id}>• {p.customer_name}: {formatPaise(p.amount_paise)}</Muted>)}
              <Button title={t('handover.confirmAll', { amount: formatPaise(c.pending_paise) })} onPress={() => confirm(c)} busy={busy === c.user_id} />
            </View>
          ))}
        </Card>
      )}

      {(!isOwner || mine.some((m) => m.pending_count > 0)) && (
        <Card>
          <Text style={styles.h}>{t('handover.myCash')}</Text>
          {mine.every((m) => m.pending_count === 0) && <Muted>{t('handover.myCashNone')}</Muted>}
          {mine.map((m) => (
            <View key={m.kitchen_id} style={styles.item}>
              {m.pending_count > 0 && <Text style={styles.name}>{formatPaise(m.pending_paise)}</Text>}
              {m.pending.map((p) => <Muted key={p.payment_id}>• {p.customer_name}: {formatPaise(p.amount_paise)}</Muted>)}
              <Muted>{t('handover.settled', { amount: formatPaise(m.confirmed_paise) })}</Muted>
            </View>
          ))}
        </Card>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space(4), gap: space(3) },
  h: { fontSize: 17, fontWeight: '600', color: colors.ink, marginBottom: space(1) },
  item: { gap: space(1), paddingVertical: space(2), borderTopWidth: 1, borderTopColor: colors.line },
  name: { fontSize: 15, fontWeight: '600', color: colors.ink },
  row: { flexDirection: 'row', gap: space(2) },
});
