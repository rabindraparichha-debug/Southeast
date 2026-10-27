import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from 'react-native';
import { colors, radius, space } from './theme';

export function Screen({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[styles.screen, style]}>{children}</View>;
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Title({ children }: { children: ReactNode }) {
  return <Text style={styles.title}>{children}</Text>;
}

export function Muted({ children }: { children: ReactNode }) {
  return <Text style={styles.muted}>{children}</Text>;
}

export function Label({ children }: { children: ReactNode }) {
  return <Text style={styles.label}>{children}</Text>;
}

export function Input(props: TextInputProps) {
  return <TextInput placeholderTextColor={colors.muted} {...props} style={[styles.input, props.style]} />;
}

export function Button({ title, onPress, disabled, busy, variant = 'primary' }: {
  title: string; onPress: () => void; disabled?: boolean; busy?: boolean; variant?: 'primary' | 'secondary';
}) {
  const primary = variant === 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        styles.button,
        primary ? styles.buttonPrimary : styles.buttonSecondary,
        (disabled || busy) && { opacity: 0.5 },
        pressed && { opacity: 0.8 },
      ]}
    >
      {busy ? <ActivityIndicator color={primary ? '#fff' : colors.ink} /> : <Text style={[styles.buttonText, !primary && { color: colors.ink }]}>{title}</Text>}
    </Pressable>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <Text style={styles.error}>{children}</Text>;
}

export function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, selected && styles.chipOn]}>
      <Text style={[styles.chipText, selected && { color: '#fff' }]}>{label}</Text>
    </Pressable>
  );
}

export const DIET_COLOR = { veg: colors.veg, nonveg: colors.nonveg, jain: colors.jain } as const;
export const DIET_LABEL = { veg: 'Veg', nonveg: 'Non-veg', jain: 'Jain' } as const;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, padding: space(4), gap: space(3) },
  card: { backgroundColor: colors.card, borderRadius: radius, padding: space(4), borderWidth: 1, borderColor: colors.line, gap: space(2) },
  title: { fontSize: 20, fontWeight: '600', color: colors.ink },
  muted: { fontSize: 14, color: colors.muted },
  label: { fontSize: 14, fontWeight: '500', color: colors.inkSoft },
  input: { borderWidth: 1, borderColor: colors.line, borderRadius: 10, paddingHorizontal: space(3), paddingVertical: space(3), fontSize: 16, backgroundColor: '#fff', color: colors.ink },
  button: { borderRadius: 10, paddingVertical: space(3), alignItems: 'center', justifyContent: 'center', minHeight: 48 },
  buttonPrimary: { backgroundColor: colors.brand },
  buttonSecondary: { backgroundColor: '#fff', borderWidth: 1, borderColor: colors.line },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  error: { color: colors.danger, fontSize: 14 },
  chip: { paddingHorizontal: space(3), paddingVertical: space(2), borderRadius: 999, borderWidth: 1, borderColor: colors.line, backgroundColor: '#fff' },
  chipOn: { backgroundColor: colors.brand, borderColor: colors.brand },
  chipText: { fontSize: 14, color: colors.inkSoft },
});
