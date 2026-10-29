import { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Redirect, router, useFocusEffect } from 'expo-router';
import { formatServiceDate } from '@tiffin/core';
import { supabase } from '@/lib/supabase';
import { useKitchen } from '@/lib/session';
import { friendlyError } from '@/lib/errors';
import { formatQty, formatVariance, type InventoryAlert, type StockRow } from '@/lib/stock';
import { Card, ErrorText, Input, Muted } from '@/components/ui';
import { LowBadge } from '@/components/stock-ui';
import { colors, radius, space } from '@/components/theme';
import { t } from '@/i18n';

function alertText(a: InventoryAlert): string {
  if (a.type === 'low_stock') {
    return t('stock.alert.low', { item: a.item, stock: `${formatQty(a.stock)} ${a.unit}`, min: `${formatQty(a.min_qty)} ${a.unit}` });
  }
  if (a.type === 'price_jump') {
    return t(a.pct >= 0 ? 'stock.alert.priceUp' : 'stock.alert.priceDown', { item: a.item, pct: Math.abs(Math.round(a.pct)), date: formatServiceDate(a.bill_date) });
  }
  return t('stock.alert.variance', { item: a.item, variance: formatVariance(a.variance, a.unit), date: formatServiceDate(a.date) });
}

// The kitchen's stock at a glance plus quick entry. Values, costs and reports stay on the web.
export default function Stock() {
  const kitchen = useKitchen();
  const [rows, setRows] = useState<StockRow[]>([]);
  const [alerts, setAlerts] = useState<InventoryAlert[]>([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (kitchen.role === 'rider') return;
    setLoading(true);
    const [levels, al] = await Promise.all([
      supabase.rpc('stock_levels', { p_kitchen: kitchen.kitchenId }),
      supabase.rpc('inventory_alerts', { p_kitchen: kitchen.kitchenId }),
    ]);
    setLoading(false);
    setError(levels.error ? friendlyError(levels.error) : al.error ? friendlyError(al.error) : '');
    setRows((levels.data ?? []).filter((r) => r.active));
    setAlerts((al.data as unknown as InventoryAlert[] | null) ?? []);
  }, [kitchen]);

  useFocusEffect(useCallback(() => void load(), [load]));

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? rows.filter((r) => r.name.toLowerCase().includes(s)) : rows;
  }, [rows, q]);

  if (kitchen.role === 'rider') return <Redirect href="/rider" />;

  const header = (
    <View style={styles.header}>
      <View style={styles.actions}>
        <Action label={t('stock.purchase')} emoji="🧾" onPress={() => router.push('/stock/purchase')} testID="action-purchase" />
        <Action label={t('stock.waste')} emoji="🗑️" onPress={() => router.push('/stock/waste')} testID="action-waste" />
        <Action label={t('stock.count')} emoji="⚖️" onPress={() => router.push('/stock/count')} testID="action-count" />
      </View>
      <ErrorText>{error}</ErrorText>
      {alerts.length > 0 && (
        <Card style={styles.alerts}>
          <Text style={styles.alertsTitle}>{t('stock.alerts')}</Text>
          {alerts.map((a, i) => (
            <Text key={`${a.type}-${a.item_id}-${i}`} style={[styles.alert, a.type === 'low_stock' && { color: colors.danger }]} testID={`alert-${a.type}`}>
              • {alertText(a)}
            </Text>
          ))}
        </Card>
      )}
      <Input value={q} onChangeText={setQ} placeholder={t('stock.search')} clearButtonMode="while-editing" testID="stock-search" />
    </View>
  );

  return (
    <FlatList
      style={styles.wrap}
      data={shown}
      keyExtractor={(r) => r.item_id}
      ListHeaderComponent={header}
      ListFooterComponent={rows.length > 0 ? <View style={styles.footer}><Muted>{t('stock.reportsOnWeb')}</Muted></View> : undefined}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
      ItemSeparatorComponent={() => <View style={styles.sep} />}
      ListEmptyComponent={!loading ? <Text style={styles.empty}>{q ? t('stock.noMatch') : t('stock.empty')}</Text> : undefined}
      renderItem={({ item }) => (
        <View style={styles.item} testID={`stock-row-${item.name}`}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.name}>{item.name}</Text>
            {item.min_qty > 0 && <Text style={styles.sub}>{t('stock.min', { min: formatQty(item.min_qty), unit: item.unit })}</Text>}
          </View>
          <View style={styles.right}>
            {item.low && <LowBadge />}
            <Text style={[styles.qty, item.low && { color: colors.danger }]}>{formatQty(item.stock)} {item.unit}</Text>
          </View>
        </View>
      )}
    />
  );
}

function Action({ label, emoji, onPress, testID }: { label: string; emoji: string; onPress: () => void; testID: string }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" testID={testID} style={({ pressed }) => [styles.action, pressed && { opacity: 0.8 }]}>
      <Text style={styles.actionEmoji}>{emoji}</Text>
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg },
  header: { padding: space(3), gap: space(3) },
  actions: { flexDirection: 'row', gap: space(2) },
  action: { flex: 1, backgroundColor: colors.brand, borderRadius: radius, paddingVertical: space(3), alignItems: 'center', gap: 2 },
  actionEmoji: { fontSize: 20 },
  actionText: { color: '#fff', fontWeight: '600', fontSize: 15 },
  alerts: { backgroundColor: colors.brandSoft, borderColor: '#FED7AA' },
  alertsTitle: { fontSize: 15, fontWeight: '600', color: colors.ink },
  alert: { fontSize: 14, color: colors.inkSoft },
  item: { flexDirection: 'row', alignItems: 'center', gap: space(3), paddingHorizontal: space(4), paddingVertical: space(3), backgroundColor: colors.card },
  name: { fontSize: 16, fontWeight: '600', color: colors.ink },
  sub: { fontSize: 13, color: colors.muted },
  right: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  qty: { fontSize: 16, fontWeight: '600', color: colors.ink, minWidth: 72, textAlign: 'right' },
  sep: { height: 1, backgroundColor: colors.line },
  empty: { textAlign: 'center', color: colors.muted, padding: space(8) },
  footer: { padding: space(4), alignItems: 'center' },
});
