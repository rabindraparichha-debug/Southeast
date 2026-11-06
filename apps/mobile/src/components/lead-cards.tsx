import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatPaise } from '@tiffin/core';
import { supabase } from '@/lib/supabase';
import { t } from '@/i18n';
import { Card, Muted } from './ui';
import { colors, space } from './theme';

type Summary = { requests: number; cashPaise: number; cashCount: number; duesPaise: number; duesCount: number };

/**
 * Today, for owners and managers: rider requests waiting for approval, rider cash to confirm and
 * dues, each opening its screen. Reloads with the Today screen (version).
 */
export function LeadCards({ kitchenId, version }: { kitchenId: string; version: number }) {
  const [s, setS] = useState<Summary | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [req, cash, dues] = await Promise.all([
        supabase.rpc('change_requests_list', { p_kitchen: kitchenId, p_status: 'pending', p_limit: 100 }),
        supabase.from('payments').select('amount_paise').eq('kitchen_id', kitchenId).eq('status', 'pending').limit(500),
        supabase.rpc('dues_list', { p_kitchen: kitchenId }),
      ]);
      if (!alive || (req.error && cash.error && dues.error)) return;
      const cashRows = (cash.data ?? []) as { amount_paise: number }[];
      const dueRows = (dues.data ?? []) as { amount_owed_paise: number }[];
      setS({
        requests: Array.isArray(req.data) ? req.data.length : 0,
        cashPaise: cashRows.reduce((n, r) => n + r.amount_paise, 0),
        cashCount: cashRows.length,
        duesPaise: dueRows.reduce((n, r) => n + r.amount_owed_paise, 0),
        duesCount: dueRows.length,
      });
    })();
    return () => {
      alive = false;
    };
  }, [kitchenId, version]);

  if (!s) return null;
  return (
    <Card>
      <Row
        title={t('lead.requests')}
        value={s.requests > 0 ? t('lead.requestsWaiting', { n: s.requests }) : t('lead.requestsNone')}
        warn={s.requests > 0}
        onPress={() => router.push('/requests')}
      />
      <Row
        title={t('lead.money')}
        value={[
          s.cashCount > 0 ? t('lead.cash', { amount: formatPaise(s.cashPaise), n: s.cashCount }) : null,
          s.duesCount > 0 ? t('lead.dues', { amount: formatPaise(s.duesPaise), n: s.duesCount }) : null,
        ].filter(Boolean).join(' · ') || t('lead.moneyClear')}
        warn={s.cashCount > 0}
        onPress={() => router.push('/money')}
      />
    </Card>
  );
}

function Row({ title, value, warn, onPress }: { title: string; value: string; warn: boolean; onPress: () => void }) {
  return (
    <Pressable style={styles.row} onPress={onPress} accessibilityRole="button">
      <View style={{ flex: 1 }}>
        <Text style={styles.title}>{title}</Text>
        {warn ? <Text style={styles.warn}>{value}</Text> : <Muted>{value}</Muted>}
      </View>
      <Text style={styles.chev}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space(2), paddingVertical: space(1) },
  title: { fontSize: 16, fontWeight: '600', color: colors.ink },
  warn: { fontSize: 14, fontWeight: '600', color: colors.jain },
  chev: { fontSize: 24, color: colors.muted },
});
