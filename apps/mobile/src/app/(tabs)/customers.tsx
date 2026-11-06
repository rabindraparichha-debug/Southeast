import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Link, useFocusEffect } from 'expo-router';
import { formatPhone, normalizePhone } from '@tiffin/core';
import type { View as DbView } from '@tiffin/db';
import { supabase } from '@/lib/supabase';
import { useKitchen } from '@/lib/session';
import { isLead } from '@/lib/roles';
import { DIET_COLOR, DIET_LABEL, Input } from '@/components/ui';
import { StaleBanner } from '@/components/offline-banner';
import { cachedFetch, useCacheScope, type Stale } from '@/lib/cached-fetch';
import { CUSTOMER_LIST_LIMIT, filterCachedCustomers, offlineSearchPartial } from '@/lib/screen-cache';
import { colors, radius, space } from '@/components/theme';
import { t } from '@/i18n';

type Row = DbView<'customers_v'>;

export default function Customers() {
  const kitchen = useKitchen();
  const isOwner = isLead(kitchen.role); // owner or manager: add customers, search by full number
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const scope = useCacheScope();
  const [stale, setStale] = useState<Stale | null>(null); // showing the copy saved on this phone
  const [partial, setPartial] = useState(false); // offline search over a saved list cut at the limit

  const load = useCallback(async (query: string) => {
    setLoading(true);
    // The full list is saved on the phone (no phone numbers for staff); offline, a search filters that copy.
    const res = await cachedFetch<Row[]>({
      scope, screen: 'customers', save: query === '',
      fetch: async () => {
        const { data, error } = await supabase.rpc('search_customers', { p_kitchen: kitchen.kitchenId, p_q: query, p_limit: CUSTOMER_LIST_LIMIT });
        return { data: data ?? [], error };
      },
      onCached: query === '' ? (d, savedAt) => { setRows(d); setStale({ savedAt, offline: false, error: '', updating: true }); } : undefined,
    });
    setRows(res.stale ? filterCachedCustomers(res.data ?? [], query) : res.data ?? []);
    setStale(res.stale);
    setPartial(res.stale ? offlineSearchPartial(res.data?.length ?? 0, query) : false);
    setLoading(false);
  }, [kitchen.kitchenId, scope]);

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
      {stale && (
        <View style={styles.banner}>
          <StaleBanner stale={stale} />
          {partial && <Text style={styles.partial}>{t('customers.offlinePartial', { n: CUSTOMER_LIST_LIMIT })}</Text>}
        </View>
      )}
      <FlatList
        data={rows}
        keyExtractor={(c) => c.id!}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => load(q)} />}
        ItemSeparatorComponent={() => <View style={styles.sep} />}
        // D-118: a full number lists every customer on it (siblings, a family phone).
        ListHeaderComponent={isOwner && rows.length > 1 && normalizePhone(q) ? <Text style={styles.shared}>{t('customers.sharedPhone', { n: rows.length })}</Text> : undefined}
        ListEmptyComponent={!loading && (!stale || stale.savedAt) ? <Text style={styles.empty}>{q ? t('customers.noMatch') : t('customers.empty')}</Text> : undefined}
        renderItem={({ item }) => (
          <Link href={{ pathname: '/customer/[id]', params: { id: item.id! } }} asChild>
            <Pressable style={styles.item}>
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{item.name}{item.platform_sourced ? <Text style={styles.platform}>  {t('customers.platform')}</Text> : null}</Text>
                {/* Accountants see no addresses (D-146; the server sends none either). */}
                {kitchen.role !== 'accountant' && (
                  <Text style={styles.sub} numberOfLines={1}>
                    {[item.landmark, item.area].filter(Boolean).join(', ') || '—'}
                  </Text>
                )}
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
  banner: { paddingHorizontal: space(3), paddingBottom: space(2), gap: space(1) },
  partial: { fontSize: 13, color: colors.inkSoft },
  add: { backgroundColor: colors.brand, borderRadius: radius, paddingHorizontal: space(4), justifyContent: 'center' },
  addText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  item: { flexDirection: 'row', gap: space(3), paddingHorizontal: space(4), paddingVertical: space(3), backgroundColor: colors.card },
  name: { fontSize: 16, fontWeight: '600', color: colors.ink },
  sub: { fontSize: 13, color: colors.muted },
  diet: { fontSize: 12, fontWeight: '600' },
  sep: { height: 1, backgroundColor: colors.line },
  empty: { textAlign: 'center', color: colors.muted, padding: space(8) },
  shared: { paddingHorizontal: space(4), paddingBottom: space(2), color: colors.inkSoft, fontWeight: '600' },
});
