import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Redirect, router, useFocusEffect } from 'expo-router';
import { SLOT_LABEL, addDays, formatIstShort, formatServiceDate, istDate } from '@tiffin/core';
import type { Database, MealSlot, SlotSummary } from '@tiffin/db';
import { supabase } from '@/lib/supabase';
import { useKitchen } from '@/lib/session';
import { Card, Muted, Title } from '@/components/ui';
import { SlotCard } from '@/components/slot-card';
import { colors, space } from '@/components/theme';
import { t } from '@/i18n';

type Change = Database['public']['Functions']['change_feed']['Returns'][number];
const TYPE: Record<Change['type'], string> = { skip: 'Skip', pause: 'Pause', resume: 'Resume', address: 'Address', cancel: 'Cancel' };

export default function Today() {
  const kitchen = useKitchen();
  const [slots, setSlots] = useState<SlotSummary[]>([]);
  const [changes, setChanges] = useState<Change[]>([]);
  const [todo, setTodo] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (kitchen.role === 'rider') return;
    const today = istDate();
    const wanted: [string, MealSlot][] = [[today, 'lunch'], [today, 'dinner'], [addDays(today, 1), 'lunch'], [addDays(today, 1), 'dinner']];
    const [results, feed] = await Promise.all([
      Promise.all(wanted.map(([d, s]) => supabase.rpc('slot_summary', { p_kitchen: kitchen.kitchenId, p_date: d, p_slot: s }))),
      supabase.rpc('change_feed', { p_kitchen: kitchen.kitchenId, p_limit: 20 }),
    ]);
    setSlots(results.map((r) => r.data as unknown as SlotSummary).filter(Boolean));
    setChanges(feed.data ?? []);
    if (kitchen.role === 'owner') {
      // Onboarding: what is left before the kitchen can take customers from the platform.
      const { data } = await supabase.rpc('kitchen_checklist', { p_kitchen: kitchen.kitchenId });
      setTodo(((data ?? []) as { key: string; done: boolean }[]).filter((i) => !i.done).map((i) => i.key));
    }
  }, [kitchen]);

  useFocusEffect(useCallback(() => void load(), [load]));

  if (kitchen.role === 'rider') return <Redirect href="/rider" />;

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
    >
      <Title>{kitchen.kitchenName}</Title>
      {todo.length > 0 && (
        <Card>
          <Text style={styles.cardTitle}>{t('checklist.title')}</Text>
          {todo.map((key) => <Muted key={key}>• {t(`checklist.${key}`)}</Muted>)}
          <Muted>{t('checklist.web')}</Muted>
        </Card>
      )}
      <View style={styles.grid}>
        {slots.map((s) => (
          <SlotCard key={`${s.service_date}-${s.slot}`} s={s} onPress={() => router.push({ pathname: '/sheet', params: { date: s.service_date, slot: s.slot } })} />
        ))}
      </View>
      <Card>
        <Text style={styles.cardTitle}>{t('today.changes')}</Text>
        {changes.length === 0 && <Muted>{t('today.noChanges')}</Muted>}
        {changes.map((c) => (
          <View key={c.change_id} style={styles.change}>
            <Text style={styles.changeText}>
              <Text style={{ fontWeight: '600' }}>{c.customer_name}</Text> · {TYPE[c.type]} {formatServiceDate(c.from_date)}
              {c.to_date && c.to_date !== c.from_date ? ` – ${formatServiceDate(c.to_date)}` : ''}{c.slot ? ` (${SLOT_LABEL[c.slot]})` : ''}
            </Text>
            <Muted>{formatIstShort(c.requested_at)}{c.after_cutoff ? (c.late_waived ? ' · late, waived' : ' · late, charged') : ''}</Muted>
          </View>
        ))}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space(4), gap: space(3) },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space(3) },
  cardTitle: { fontSize: 16, fontWeight: '600', color: colors.ink },
  change: { paddingVertical: space(2), borderTopWidth: 1, borderTopColor: colors.line },
  changeText: { color: colors.inkSoft },
});
