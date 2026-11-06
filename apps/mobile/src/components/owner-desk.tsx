// Owner's delivery desk on Today (audit items 25 and 29): credits riders asked for, cash riders hold,
// and the alerts list (which also works without push or WhatsApp).
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatPaise } from '@tiffin/core';
import { Card } from './ui';
import { colors, space } from './theme';
import { supabase } from '@/lib/supabase';
import { t } from '@/i18n';

export function OwnerDesk({ kitchenId, version }: { kitchenId: string; version: number }) {
  const [credits, setCredits] = useState(0);
  const [cash, setCash] = useState(0);

  useEffect(() => {
    void (async () => {
      const [c, h] = await Promise.all([
        supabase.rpc('stop_credit_requests', { p_kitchen: kitchenId }),
        supabase.rpc('cash_handover', { p_kitchen: kitchenId }),
      ]);
      setCredits(((c.data ?? []) as unknown[]).length);
      const collectors = ((h.data ?? {}) as unknown as { collectors?: { pending_paise: number }[] }).collectors ?? [];
      setCash(collectors.reduce((s, x) => s + x.pending_paise, 0));
    })();
  }, [kitchenId, version]);

  return (
    <Card>
      <Text style={styles.h}>{t('desk.title')}</Text>
      <View style={styles.row}>
        <Pressable style={styles.tile} onPress={() => router.push('/handover')}>
          <Text style={styles.big}>{credits}</Text>
          <Text style={styles.small}>{t('desk.credits', { n: credits })}</Text>
        </Pressable>
        <Pressable style={styles.tile} onPress={() => router.push('/handover')}>
          <Text style={styles.big}>{formatPaise(cash)}</Text>
          <Text style={styles.small}>{t('desk.cash', { amount: formatPaise(cash) })}</Text>
        </Pressable>
        <Pressable style={styles.tile} onPress={() => router.push('/notifications')}>
          <Text style={styles.big}>🔔</Text>
          <Text style={styles.small}>{t('desk.alerts')}</Text>
        </Pressable>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  h: { fontSize: 16, fontWeight: '600', color: colors.ink },
  row: { flexDirection: 'row', gap: space(2) },
  tile: { flex: 1, backgroundColor: colors.brandSoft, borderRadius: 10, padding: space(2), gap: 2 },
  big: { fontSize: 18, fontWeight: '700', color: colors.ink },
  small: { fontSize: 12, color: colors.inkSoft },
});
