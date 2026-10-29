import { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { formatIstShort } from '@tiffin/core';
import { supabase } from '@/lib/supabase';
import { useKitchen } from '@/lib/session';
import { colors, space } from '@/components/theme';
import { t } from '@/i18n';

type Conv = { id: string; customer_id: string | null; contact_name: string | null; phone_last4: string; handoff_open: boolean; unread_count: number; last_message_at: string | null };

export default function Inbox() {
  const kitchen = useKitchen();
  const [rows, setRows] = useState<(Conv & { name: string; preview: string; complaint: boolean })[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data: convs } = await supabase.from('conversations').select('id, customer_id, contact_name, phone_last4, handoff_open, unread_count, last_message_at')
      .eq('kitchen_id', kitchen.kitchenId).not('last_message_at', 'is', null).order('last_message_at', { ascending: false }).limit(50);
    const ids = (convs ?? []).map((c) => c.customer_id).filter(Boolean) as string[];
    const [{ data: names }, { data: msgs }, { data: open }] = await Promise.all([
      ids.length ? supabase.from('customers_v').select('id, name').in('id', ids) : Promise.resolve({ data: [] as { id: string | null; name: string | null }[] }),
      supabase.from('messages').select('conversation_id, body, created_at').eq('kitchen_id', kitchen.kitchenId).order('created_at', { ascending: false }).limit(200),
      supabase.from('complaints').select('conversation_id').eq('kitchen_id', kitchen.kitchenId).in('status', ['open', 'escalated']),
    ]);
    const nameOf = new Map((names ?? []).map((n) => [n.id, n.name]));
    const last = new Map<string, string>();
    for (const m of msgs ?? []) if (!last.has(m.conversation_id)) last.set(m.conversation_id, (m.body ?? '').split('\n')[0]!);
    const withComplaint = new Set((open ?? []).map((o) => o.conversation_id));
    setRows((convs ?? []).map((c) => ({
      ...c, name: (c.customer_id && nameOf.get(c.customer_id)) || c.contact_name || `•••${c.phone_last4}`,
      preview: last.get(c.id) ?? '', complaint: withComplaint.has(c.id),
    })));
    setLoading(false);
  }, [kitchen.kitchenId]);

  useFocusEffect(useCallback(() => void load(), [load]));

  return (
    <FlatList
      style={{ backgroundColor: colors.bg }}
      data={rows}
      keyExtractor={(r) => r.id}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
      ListEmptyComponent={!loading ? <Text style={styles.empty}>{t('inbox.empty')}</Text> : undefined}
      ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: colors.line }} />}
      renderItem={({ item }) => (
        <Pressable style={styles.item} onPress={() => router.push({ pathname: '/chat/[id]', params: { id: item.id, name: item.name } })}>
          <View style={styles.row}>
            <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
            <Text style={styles.time}>{item.last_message_at ? formatIstShort(item.last_message_at) : ''}</Text>
          </View>
          <Text style={styles.preview} numberOfLines={1}>{item.preview}</Text>
          <View style={styles.badges}>
            {item.unread_count > 0 && <Text style={[styles.badge, styles.blue]}>{t('inbox.new', { n: item.unread_count })}</Text>}
            {item.handoff_open && <Text style={[styles.badge, styles.amber]}>{t('inbox.needsReply')}</Text>}
            {item.complaint && <Text style={[styles.badge, styles.red]}>{t('inbox.complaint')}</Text>}
          </View>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  empty: { textAlign: 'center', color: colors.muted, padding: space(8) },
  item: { padding: space(4), backgroundColor: colors.card, gap: 2 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: space(2) },
  name: { fontSize: 16, fontWeight: '600', color: colors.ink, flexShrink: 1 },
  time: { fontSize: 12, color: colors.muted },
  preview: { fontSize: 13, color: colors.muted },
  badges: { flexDirection: 'row', gap: space(1), marginTop: 2 },
  badge: { fontSize: 11, paddingHorizontal: space(2), paddingVertical: 1, borderRadius: 999, overflow: 'hidden' },
  blue: { backgroundColor: '#DBEAFE', color: '#1E40AF' },
  amber: { backgroundColor: '#FEF3C7', color: '#92400E' },
  red: { backgroundColor: '#FEE2E2', color: '#991B1B' },
});
