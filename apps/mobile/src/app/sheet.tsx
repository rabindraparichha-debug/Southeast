import { useEffect, useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { SLOT_LABEL, formatServiceDate } from '@tiffin/core';
import type { Database, MealSlot } from '@tiffin/db';
import { supabase } from '@/lib/supabase';
import { useKitchen } from '@/lib/session';
import { DIET_COLOR, DIET_LABEL } from '@/components/ui';
import { healthSummary } from '@/components/slot-card';
import { colors, space } from '@/components/theme';
import { t } from '@/i18n';

type Row = Database['public']['Functions']['packing_list']['Returns'][number];

// Packing list for one slot (for kitchens without a printer).
export default function Sheet() {
  const { date, slot } = useLocalSearchParams<{ date: string; slot: MealSlot }>();
  const kitchen = useKitchen();
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    supabase.rpc('packing_list', { p_kitchen: kitchen.kitchenId, p_date: date, p_slot: slot }).then(({ data }) => setRows(data ?? []));
  }, [kitchen.kitchenId, date, slot]);

  // Meals switched to veg today and meals per health tag (counted rows only, like the totals).
  const summary = useMemo(() => {
    let veg = 0;
    const byHealth: Record<string, number> = {};
    for (const r of rows) {
      if (r.status === 'skipped') continue;
      if (r.veg_override) veg += r.qty;
      for (const tag of r.health_tags ?? []) byHealth[tag] = (byHealth[tag] ?? 0) + r.qty;
    }
    return { veg, health: healthSummary(byHealth) };
  }, [rows]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{ title: `${formatServiceDate(date)} · ${SLOT_LABEL[slot]}` }} />
      <FlatList
        data={rows}
        keyExtractor={(r) => r.order_id}
        ListHeaderComponent={
          <View style={styles.headerBox}>
            <Text style={styles.header}>{t('sheet.title')} ({rows.length})</Text>
            {(summary.veg > 0 || summary.health) && (
              <Text style={styles.sub}>{t('sheet.summary', { n: summary.veg, health: summary.health || '—' })}</Text>
            )}
          </View>
        }
        ListEmptyComponent={<Text style={styles.empty}>{t('sheet.empty')}</Text>}
        ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: colors.line }} />}
        renderItem={({ item, index }) => (
          <View style={[styles.item, item.status === 'skipped' && { backgroundColor: '#FFFBEB' }]}>
            <Text style={styles.num}>{index + 1}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{item.customer_name}{item.qty > 1 ? ` ×${item.qty}` : ''}</Text>
              {item.office_name ? <Text style={styles.office}>🏢 {t('sheet.office', { name: item.office_name })}</Text> : null}
              <Text style={styles.sub}>{[item.line1, item.landmark, item.area].filter(Boolean).join(', ')}</Text>
              {(item.delivery_notes || item.customer_notes) && (
                <Text style={styles.sub}>📝 {[item.delivery_notes, item.customer_notes].filter(Boolean).join(' · ')}</Text>
              )}
              {item.health_tags && item.health_tags.length > 0 && (
                <View style={styles.tags}>
                  {item.health_tags.map((tag) => <Text key={tag} style={styles.tag}>{t(`health.${tag}`)}</Text>)}
                </View>
              )}
              {item.status === 'skipped' && <Text style={styles.warn}>{t('sheet.dontDeliver')}</Text>}
            </View>
            <View style={{ alignItems: 'flex-end', gap: 2 }}>
              <Text style={[styles.diet, { color: DIET_COLOR[item.diet] }]}>{DIET_LABEL[item.diet]}</Text>
              {item.veg_override && <Text style={styles.vegDay}>{t('sheet.vegDay')}</Text>}
            </View>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  headerBox: { padding: space(4), gap: space(1) },
  header: { fontSize: 16, fontWeight: '600', color: colors.ink },
  office: { fontSize: 13, color: colors.inkSoft, fontWeight: '600' },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: space(1), marginTop: 2 },
  tag: { fontSize: 11, fontWeight: '600', color: colors.jain, backgroundColor: '#FEF3C7', paddingHorizontal: space(2), paddingVertical: 1, borderRadius: 999, overflow: 'hidden' },
  vegDay: { fontSize: 11, fontWeight: '600', color: colors.veg },
  empty: { padding: space(8), textAlign: 'center', color: colors.muted },
  item: { flexDirection: 'row', gap: space(3), padding: space(3), backgroundColor: colors.card },
  num: { width: 24, color: colors.muted, fontWeight: '600' },
  name: { fontSize: 15, fontWeight: '600', color: colors.ink },
  sub: { fontSize: 13, color: colors.muted },
  warn: { fontSize: 12, color: '#B45309', fontWeight: '600' },
  diet: { fontSize: 12, fontWeight: '600' },
});
