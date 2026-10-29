import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SLOT_LABEL, formatIstShort, formatServiceDate } from '@tiffin/core';
import type { SlotSummary } from '@tiffin/db';
import { colors, radius, space } from './theme';
import { t } from '@/i18n';

export function SlotCard({ s, onPress }: { s: SlotSummary; onPress?: () => void }) {
  const totals = s.locked && s.locked_totals ? s.locked_totals : s.live;
  return (
    <Pressable onPress={onPress} style={styles.card} accessibilityRole="button">
      <View style={styles.row}>
        <Text style={styles.title}>{formatServiceDate(s.service_date)} · {SLOT_LABEL[s.slot]}</Text>
        <Text style={[styles.badge, s.locked ? styles.final : styles.preview]}>{s.locked ? t('today.final') : t('today.preview')}</Text>
      </View>
      <Text style={styles.sub}>
        {s.locked ? t('today.lockedAt', { time: formatIstShort(s.locked_at!) }) : t('today.closesAt', { time: formatIstShort(s.cutoff_at) })}
      </Text>
      <Text style={styles.big}>{totals.total_meals} <Text style={styles.sub}>{t('today.meals')}</Text></Text>
      <Text style={styles.sub}>
        Veg {totals.by_diet.veg} · Non-veg {totals.by_diet.nonveg} · Jain {totals.by_diet.jain}
      </Text>
      <Text style={styles.sub}>
        {t('today.skipped', { n: s.live.skipped })}
        {s.live.late_skips > 0 ? ` · ${t('today.lateSkips', { n: s.live.late_skips })}` : ''}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: radius, borderWidth: 1, borderColor: colors.line, padding: space(4), gap: space(1), flexBasis: '47%', flexGrow: 1 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space(2) },
  title: { fontSize: 14, fontWeight: '600', color: colors.ink, flexShrink: 1 },
  sub: { fontSize: 12, color: colors.muted },
  big: { fontSize: 28, fontWeight: '600', color: colors.ink, marginTop: space(1) },
  badge: { fontSize: 11, paddingHorizontal: space(2), paddingVertical: 2, borderRadius: 999, overflow: 'hidden' },
  final: { backgroundColor: '#F1F5F9', color: colors.inkSoft },
  preview: { backgroundColor: '#DBEAFE', color: '#1E40AF' },
});
