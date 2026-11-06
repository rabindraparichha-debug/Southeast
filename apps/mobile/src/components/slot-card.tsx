import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { SLOT_LABEL, formatIstShort, formatServiceDate } from '@tiffin/core';
import type { SlotSummary, SlotTotals } from '@tiffin/db';
import { colors, radius, space } from './theme';
import { Button, ErrorText } from './ui';
import { t } from '@/i18n';
import { supabase } from '@/lib/supabase';
import { friendlyError } from '@/lib/errors';

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

/** Minutes after the cutoff before an unlocked slot counts as "not frozen" (the lock job runs every minute). */
export const FREEZE_GRACE_MS = 5 * 60_000;

/** True when the cutoff passed (plus grace) with meals ordered but no count snapshot: the engine missed it. */
export function isCountOverdue(s: SlotSummary, now = Date.now()): boolean {
  return !s.locked && s.live.orders > 0 && now > Date.parse(s.cutoff_at) + FREEZE_GRACE_MS;
}

/** "Count not frozen" with Freeze now for the owner (freeze_slot: the idempotent lock). */
function NotFrozen({ s, kitchenId, canFreeze, onFrozen }: { s: SlotSummary; kitchenId?: string; canFreeze: boolean; onFrozen?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const freeze = () => {
    if (!kitchenId) return;
    Alert.alert(t('today.freezeConfirmTitle'), t('today.freezeConfirm'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('today.freezeNow'),
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          setError('');
          const { error } = await supabase.rpc('freeze_slot', { p_kitchen: kitchenId, p_date: s.service_date, p_slot: s.slot });
          setBusy(false);
          if (error) setError(friendlyError(error));
          else onFrozen?.();
        },
      },
    ]);
  };
  return (
    <View style={styles.alert} accessibilityRole="alert">
      <Text style={styles.alertText}>{t('today.notFrozen', { time: formatIstShort(s.cutoff_at) })}</Text>
      {canFreeze && kitchenId
        ? <Button title={busy ? t('today.freezing') : t('today.freezeNow')} onPress={freeze} busy={busy} />
        : <Text style={styles.alertText}>{t('today.askOwnerToFreeze')}</Text>}
      <ErrorText>{error}</ErrorText>
    </View>
  );
}

export function SlotCard({ s, onPress, kitchenId, canFreeze = false, onFrozen }: {
  s: SlotSummary; onPress?: () => void; kitchenId?: string; canFreeze?: boolean; onFrozen?: () => void;
}) {
  const totals: Totals = s.locked && s.locked_totals ? s.locked_totals : s.live;
  const health = healthSummary(totals.by_health);
  const overdue = isCountOverdue(s);
  return (
    <Pressable onPress={onPress} style={[styles.card, overdue && styles.cardOverdue]} accessibilityRole="button">
      <View style={styles.row}>
        <Text style={styles.title}>{formatServiceDate(s.service_date)} · {SLOT_LABEL[s.slot]}</Text>
        <Text style={[styles.badge, s.locked ? styles.final : overdue ? styles.overdue : styles.preview]}>
          {s.locked ? t('today.final') : overdue ? t('today.notFrozenBadge') : t('today.preview')}
        </Text>
      </View>
      <Text style={styles.sub}>
        {s.closed
          ? t('today.kitchenClosed') + (s.closure_reason ? ` · ${s.closure_reason}` : '')
          : s.locked
            ? t('today.lockedAt', { time: formatIstShort(s.locked_at!) })
            : overdue
              ? t('today.notFrozenSub', { time: formatIstShort(s.cutoff_at) })
              : t('today.closesAt', { time: formatIstShort(s.cutoff_at) })}
      </Text>
      {overdue && <NotFrozen s={s} kitchenId={kitchenId} canFreeze={canFreeze} onFrozen={onFrozen} />}
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
  cardOverdue: { borderColor: '#FCA5A5', borderWidth: 2 },
  alert: { backgroundColor: '#FEF2F2', borderRadius: 8, padding: space(3), gap: space(2), marginTop: space(1) },
  alertText: { fontSize: 13, color: colors.danger },
  overdue: { backgroundColor: '#FEE2E2', color: colors.danger },
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
