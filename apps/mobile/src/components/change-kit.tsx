// Small building blocks shared by the owner's change cards (subscriptions, locked meals,
// addresses, closures). Kept apart from ui.tsx so the shared kit stays untouched.
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { addDays, formatServiceDate } from '@tiffin/core';
import { t } from '@/i18n';
import { colors, radius, space } from './theme';

export type Tone = 'green' | 'amber' | 'red' | 'blue' | 'gray';
const TONE: Record<Tone, { bg: string; fg: string }> = {
  green: { bg: '#DCFCE7', fg: '#166534' },
  amber: { bg: '#FEF3C7', fg: '#92400E' },
  red: { bg: '#FEE2E2', fg: '#991B1B' },
  blue: { bg: '#DBEAFE', fg: '#1E40AF' },
  gray: { bg: '#F1F5F9', fg: colors.inkSoft },
};

export const STATUS_TONE: Record<string, Tone> = {
  trial: 'blue', active: 'green', paused: 'gray', low_balance: 'amber', suspended: 'red', cancelled: 'gray',
};

export function Badge({ label, tone }: { label: string; tone: Tone }) {
  return <Text style={[styles.badge, { backgroundColor: TONE[tone].bg, color: TONE[tone].fg }]}>{label}</Text>;
}

/** ◀ Tue, 10 Nov ▶ : one day per tap, kept inside [min, max]. */
export function DateStepper({ value, min, max, onChange, label }: {
  value: string; min: string; max?: string; onChange: (d: string) => void; label?: string;
}) {
  const prev = addDays(value, -1);
  const next = addDays(value, 1);
  const canPrev = prev >= min;
  const canNext = !max || next <= max;
  return (
    <View style={styles.stepper}>
      {label ? <Text style={styles.stepLabel}>{label}</Text> : null}
      <Pressable accessibilityRole="button" accessibilityLabel={t('dates.prevDay')} disabled={!canPrev}
        onPress={() => onChange(prev)} style={[styles.stepBtn, !canPrev && { opacity: 0.35 }]}>
        <Text style={styles.stepTxt}>‹</Text>
      </Pressable>
      <Text style={styles.stepValue}>{formatServiceDate(value)}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={t('dates.nextDay')} disabled={!canNext}
        onPress={() => onChange(next)} style={[styles.stepBtn, !canNext && { opacity: 0.35 }]}>
        <Text style={styles.stepTxt}>›</Text>
      </Pressable>
    </View>
  );
}

/** The tinted box a preview and its Confirm / Back buttons sit in (same look as the quick actions). */
export function ConfirmBox({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.confirm}>
      <Text style={styles.confirmTitle}>{title}</Text>
      {children}
    </View>
  );
}

/** ☑ / ☐ row, like the consent box on the new-customer screen. */
export function CheckRow({ checked, onToggle, label, disabled }: { checked: boolean; onToggle: () => void; label: string; disabled?: boolean }) {
  return (
    <Pressable style={[styles.check, disabled && { opacity: 0.5 }]} onPress={onToggle} disabled={disabled}
      accessibilityRole="checkbox" accessibilityState={{ checked, disabled }}>
      <Text style={styles.box}>{checked ? '☑' : '☐'}</Text>
      <Text style={styles.checkText}>{label}</Text>
    </Pressable>
  );
}

export const kit = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  warn: { color: '#B45309', fontWeight: '600' },
  good: { color: colors.veg, fontWeight: '600' },
  saved: { color: colors.veg, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space(2) },
  item: { gap: space(2), paddingTop: space(3), borderTopWidth: 1, borderTopColor: colors.line },
  itemTitle: { fontSize: 15, fontWeight: '600', color: colors.ink, flexShrink: 1 },
  small: { fontSize: 13, color: colors.muted },
  link: { color: colors.brand, fontWeight: '600', paddingVertical: space(1), paddingHorizontal: space(1) },
});

const styles = StyleSheet.create({
  badge: { fontSize: 12, fontWeight: '600', paddingHorizontal: space(2), paddingVertical: 2, borderRadius: 999, overflow: 'hidden' },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: space(2), flexWrap: 'wrap' },
  stepLabel: { fontSize: 14, color: colors.inkSoft, flexBasis: '100%' },
  stepBtn: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  stepTxt: { fontSize: 22, color: colors.ink, lineHeight: 26 },
  stepValue: { minWidth: 110, textAlign: 'center', fontSize: 16, fontWeight: '600', color: colors.ink },
  confirm: { gap: space(2), backgroundColor: colors.brandSoft, padding: space(3), borderRadius: radius },
  confirmTitle: { fontSize: 16, fontWeight: '600', color: colors.ink },
  check: { flexDirection: 'row', gap: space(2), alignItems: 'flex-start' },
  box: { fontSize: 20, color: colors.brand },
  checkText: { flex: 1, color: colors.inkSoft, fontSize: 15 },
});
