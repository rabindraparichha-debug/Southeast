import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Redirect, useFocusEffect } from 'expo-router';
import { addDays, cutoffInstant, istDate, isoDow } from '@tiffin/core';
import type { Tables } from '@tiffin/db';
import { supabase } from '@/lib/supabase';
import { useKitchen } from '@/lib/session';
import { Card, Muted, Title } from '@/components/ui';
import { colors, space } from '@/components/theme';
import { t } from '@/i18n';

const fmt = (d: Date) =>
  d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', hour: 'numeric', minute: '2-digit' });

export default function Today() {
  const kitchen = useKitchen();
  const [k, setK] = useState<Tables<'kitchens'> | null>(null);
  const [stats, setStats] = useState({ customers: 0, active: 0, trial: 0 });
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const isOwner = kitchen.role === 'owner';
    const [{ data: kd }, { count }, subs] = await Promise.all([
      supabase.from('kitchens').select('*').eq('id', kitchen.kitchenId).single(),
      supabase.from('customers_v').select('id', { count: 'exact', head: true }).eq('kitchen_id', kitchen.kitchenId),
      isOwner ? supabase.from('subscriptions').select('status').eq('kitchen_id', kitchen.kitchenId) : Promise.resolve({ data: [] }),
    ]);
    setK(kd);
    const list = (subs.data ?? []) as { status: string }[];
    setStats({
      customers: count ?? 0,
      active: list.filter((s) => s.status === 'active' || s.status === 'low_balance').length,
      trial: list.filter((s) => s.status === 'trial').length,
    });
  }, [kitchen]);

  useFocusEffect(useCallback(() => void load(), [load]));

  if (kitchen.role === 'rider') return <Redirect href="/rider" />;

  const today = istDate();
  const tomorrow = addDays(today, 1);

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
    >
      <Title>{kitchen.kitchenName}</Title>
      <View style={styles.row}>
        <Stat label={t('today.customers')} value={stats.customers} />
        {kitchen.role === 'owner' && <Stat label={t('today.active')} value={stats.active} />}
        {kitchen.role === 'owner' && <Stat label={t('today.trial')} value={stats.trial} />}
      </View>
      {k && (
        <Card>
          <Text style={styles.cardTitle}>{t('today.windows')}</Text>
          <Line
            label={t('today.tomorrowLunch')}
            value={fmt(cutoffInstant(tomorrow, k.cutoff_lunch, k.cutoff_lunch_prev_day))}
            off={k.weekly_off.includes(isoDow(tomorrow))}
          />
          <Line
            label={t('today.todayDinner')}
            value={fmt(cutoffInstant(today, k.cutoff_dinner, k.cutoff_dinner_prev_day))}
            off={k.weekly_off.includes(isoDow(today))}
          />
        </Card>
      )}
      <Card>
        <Muted>{t('today.countsSoon')}</Muted>
      </Card>
    </ScrollView>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card style={{ flex: 1, minWidth: 100 }}>
      <Muted>{label}</Muted>
      <Text style={styles.stat}>{value}</Text>
    </Card>
  );
}

function Line({ label, value, off }: { label: string; value: string; off: boolean }) {
  return (
    <View style={styles.line}>
      <Text style={styles.lineLabel}>{label}{off ? ` (${t('today.weeklyOff')})` : ''}</Text>
      <Text style={styles.lineValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: space(4), gap: space(3) },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space(3) },
  stat: { fontSize: 26, fontWeight: '600', color: colors.ink },
  cardTitle: { fontSize: 16, fontWeight: '600', color: colors.ink },
  line: { flexDirection: 'row', justifyContent: 'space-between', gap: space(3) },
  lineLabel: { color: colors.inkSoft, flexShrink: 1 },
  lineValue: { color: colors.muted },
});
