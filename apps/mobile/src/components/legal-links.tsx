import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, space } from '@/components/theme';
import { WEB_URL } from '@/lib/env';
import { t } from '@/i18n';

/** Privacy policy and terms on the public web app (Apple guideline 5.1.1 wants them inside the app). */
export function LegalLinks() {
  if (!WEB_URL) return null;
  return (
    <View style={styles.row}>
      <Pressable onPress={() => void Linking.openURL(`${WEB_URL}/privacy`)} accessibilityRole="link">
        <Text style={styles.link}>{t('legal.privacy')}</Text>
      </Pressable>
      <Text style={styles.link}>·</Text>
      <Pressable onPress={() => void Linking.openURL(`${WEB_URL}/terms`)} accessibilityRole="link">
        <Text style={styles.link}>{t('legal.terms')}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'center', gap: space(2), marginTop: space(3) },
  link: { color: colors.muted, textDecorationLine: 'underline' },
});
