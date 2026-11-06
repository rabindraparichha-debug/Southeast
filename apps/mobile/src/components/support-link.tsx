import { Linking, Pressable, StyleSheet, Text } from 'react-native';
import { colors, space } from '@/components/theme';
import { t } from '@/i18n';

// EXPO_PUBLIC_* values are inlined at build time (apps/mobile/.env.example). Without a number it
// says where to find one, so a vendor is never left with no way forward.
const RAW = process.env.EXPO_PUBLIC_SUPPORT_WHATSAPP ?? '';

/** Digits for wa.me (a bare 10-digit Indian number gets 91), or null when no support number is set. */
export function supportNumber(raw: string = RAW): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  return digits.length >= 11 && digits.length <= 15 ? digits : null;
}

/** "Help: WhatsApp the Tiffin team" (wave 4). */
export function SupportLink({ text, fallback = true }: { text?: string; fallback?: boolean }) {
  const n = supportNumber();
  if (!n) return fallback ? <Text style={styles.hint}>{t('support.noNumber')}</Text> : null;
  const url = `https://wa.me/${n}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
  return (
    <Pressable onPress={() => void Linking.openURL(url)} accessibilityRole="link" style={styles.wrap}>
      <Text style={styles.link}>{t('support.whatsapp')}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', marginTop: space(3) },
  link: { color: colors.brand, textDecorationLine: 'underline' },
  hint: { color: colors.muted, textAlign: 'center', marginTop: space(3) },
});
