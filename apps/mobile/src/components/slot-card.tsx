import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SLOT_LABEL, formatIstShort, formatServiceDate } from '@tiffin/core';
import type { SlotSummary, SlotTotals } from '@tiffin/db';
import { colors, radius, space } from './theme';
import { t } from '@/i18n';

// P5/P6 counts. Optional: counts locked before P5 don't have them.
type Totals = SlotTotals & { veg_switched?: number; by_health?: Record<string, number> };

/** "Diabetic 3 · Low salt 2" (health tags with meal counts, biggest first). */
export function healthSummary(byHealth: Record<string, number> | null | undefined): string {
  return Object.entries(byHealth ?? {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([tag, n]) => `${t(`health.${tag}`)} ${n}`)
    .join(' · ');
}

export function SlotCard({ s, onPress }: { s: SlotSummary; onPress?: () => void }) {
  const totals: Totals = s.locked && s.locked_totals ? s.locked_totals : s.live;
  const health = healthSummary(totals.by_health);
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
      {(totals.veg_switched ?? 0) > 0 && <Text style={styles.veg}>{t('today.vegSwitched', { n: totals.veg_switched ?? 0 })}</Text>}
      {health ? <Text style={styles.health}>{t('today.health', { list: health })}</Text> : null}
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
  veg: { fontSize: 12, color: colors.veg, fontWeight: '600' },
  health: { fontSize: 12, color: colors.jain, fontWeight: '600' },
  big: { fontSize: 28, fontWeight: '600', color: colors.ink, marginTop: space(1) },
  badge: { fontSize: 11, paddingHorizontal: space(2), paddingVertical: 2, borderRadius: 999, overflow: 'hidden' },
  final: { backgroundColor: '#F1F5F9', color: colors.inkSoft },
  preview: { backgroundColor: '#DBEAFE', color: '#1E40AF' },
});
