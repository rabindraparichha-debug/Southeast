import { useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { SLOT_LABEL, formatServiceDate } from '@tiffin/core';
import type { Database, MealSlot } from '@tiffin/db';
import { supabase } from '@/lib/supabase';
import { useKitchen } from '@/lib/session';
import { DIET_COLOR, DIET_LABEL } from '@/components/ui';
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

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{ title: `${formatServiceDate(date)} · ${SLOT_LABEL[slot]}` }} />
      <FlatList
        data={rows}
        keyExtractor={(r) => r.order_id}
        ListHeaderComponent={<Text style={styles.header}>{t('sheet.title')} ({rows.length})</Text>}
        ListEmptyComponent={<Text style={styles.empty}>{t('sheet.empty')}</Text>}
        ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: colors.line }} />}
        renderItem={({ item, index }) => (
          <View style={[styles.item, item.status === 'skipped' && { backgroundColor: '#FFFBEB' }]}>
            <Text style={styles.num}>{index + 1}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{item.customer_name}{item.qty > 1 ? ` ×${item.qty}` : ''}</Text>
              <Text style={styles.sub}>{[item.line1, item.landmark, item.area].filter(Boolean).join(', ')}</Text>
              {(item.delivery_notes || item.customer_notes) && (
                <Text style={styles.sub}>📝 {[item.delivery_notes, item.customer_notes].filter(Boolean).join(' · ')}</Text>
              )}
              {item.status === 'skipped' && <Text style={styles.warn}>{t('sheet.dontDeliver')}</Text>}
            </View>
            <Text style={[styles.diet, { color: DIET_COLOR[item.diet] }]}>{DIET_LABEL[item.diet]}</Text>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  header: { padding: space(4), fontSize: 16, fontWeight: '600', color: colors.ink },
  empty: { padding: space(8), textAlign: 'center', color: colors.muted },
  item: { flexDirection: 'row', gap: space(3), padding: space(3), backgroundColor: colors.card },
  num: { width: 24, color: colors.muted, fontWeight: '600' },
  name: { fontSize: 15, fontWeight: '600', color: colors.ink },
  sub: { fontSize: 13, color: colors.muted },
  warn: { fontSize: 12, color: '#B45309', fontWeight: '600' },
  diet: { fontSize: 12, fontWeight: '600' },
});
