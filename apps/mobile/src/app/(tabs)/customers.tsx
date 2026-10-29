import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Link, useFocusEffect } from 'expo-router';
import { formatPhone } from '@tiffin/core';
import type { View as DbView } from '@tiffin/db';
import { supabase } from '@/lib/supabase';
import { useKitchen } from '@/lib/session';
import { DIET_COLOR, DIET_LABEL, Input } from '@/components/ui';
import { colors, radius, space } from '@/components/theme';
import { t } from '@/i18n';

type Row = DbView<'customers_v'>;

export default function Customers() {
  const kitchen = useKitchen();
  const isOwner = kitchen.role === 'owner';
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (query: string) => {
    setLoading(true);
    const { data } = await supabase.rpc('search_customers', { p_kitchen: kitchen.kitchenId, p_q: query, p_limit: 200 });
    setRows(data ?? []);
    setLoading(false);
  }, [kitchen.kitchenId]);

  // Debounced search as the vendor types.
  useEffect(() => {
    const id = setTimeout(() => void load(q), 250);
    return () => clearTimeout(id);
  }, [q, load]);
  useFocusEffect(useCallback(() => void load(q), [load])); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View style={styles.wrap}>
      <View style={styles.searchRow}>
        <Input style={{ flex: 1 }} value={q} onChangeText={setQ} placeholder={isOwner ? t('customers.searchOwner') : t('customers.search')} clearButtonMode="while-editing" testID="search" />
        {isOwner && (
          <Link href="/customer/new" asChild>
            <Pressable style={styles.add} accessibilityRole="button">
              <Text style={styles.addText}>+ {t('customers.add')}</Text>
            </Pressable>
          </Link>
        )}
      </View>
      <FlatList
        data={rows}
        keyExtractor={(c) => c.id!}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => load(q)} />}
        ItemSeparatorComponent={() => <View style={styles.sep} />}
        ListEmptyComponent={!loading ? <Text style={styles.empty}>{q ? t('customers.noMatch') : t('customers.empty')}</Text> : undefined}
        renderItem={({ item }) => (
          <Link href={{ pathname: '/customer/[id]', params: { id: item.id! } }} asChild>
            <Pressable style={styles.item}>
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{item.name}{item.platform_sourced ? <Text style={styles.platform}>  {t('customers.platform')}</Text> : null}</Text>
                <Text style={styles.sub} numberOfLines={1}>
                  {[item.landmark, item.area].filter(Boolean).join(', ') || '—'}
                </Text>
              </View>
              <View style={{ alignItems: 'flex-end', gap: 2 }}>
                <Text style={styles.sub}>{formatPhone(item.phone)}</Text>
                {item.diet && <Text style={[styles.diet, { color: DIET_COLOR[item.diet] }]}>{DIET_LABEL[item.diet]}</Text>}
              </View>
            </Pressable>
          </Link>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  platform: { fontSize: 12, fontWeight: '600', color: colors.brand },
  wrap: { flex: 1, backgroundColor: colors.bg },
  searchRow: { flexDirection: 'row', gap: space(2), padding: space(3) },
  add: { backgroundColor: colors.brand, borderRadius: radius, paddingHorizontal: space(4), justifyContent: 'center' },
  addText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  item: { flexDirection: 'row', gap: space(3), paddingHorizontal: space(4), paddingVertical: space(3), backgroundColor: colors.card },
  name: { fontSize: 16, fontWeight: '600', color: colors.ink },
  sub: { fontSize: 13, color: colors.muted },
  diet: { fontSize: 12, fontWeight: '600' },
  sep: { height: 1, backgroundColor: colors.line },
  empty: { textAlign: 'center', color: colors.muted, padding: space(8) },
});
