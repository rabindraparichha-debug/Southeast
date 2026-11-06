import { StyleSheet, Text, View } from 'react-native';
import { formatIstShort } from '@tiffin/core';
import type { Stale } from '@/lib/cached-fetch';
import { colors, space } from './theme';
import { t } from '@/i18n';

/**
 * Says the screen shows the copy saved on this phone (offline or the server failed), and when it
 * was saved; or that there is nothing to show yet. Nothing while the data is live.
 */
export function StaleBanner({ stale }: { stale: Stale | null }) {
  if (!stale) return null;
  const time = stale.savedAt ? formatIstShort(stale.savedAt) : null;
  const text = time
    ? stale.updating
      ? t('offline.updating', { time })
      : t(stale.offline ? 'offline.showing' : 'offline.errorShowing', { time })
    : stale.offline
      ? t('offline.noData')
      : t('offline.failed', { error: stale.error });
  return (
    <View style={[styles.banner, stale.updating ? styles.info : styles.warn]} accessibilityRole="alert" testID="stale-banner">
      <Text style={styles.text}>{stale.offline && !stale.updating ? '⚠ ' : ''}{text}</Text>
      {!stale.updating && <Text style={styles.hint}>{t('offline.pull')}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { borderRadius: 10, padding: space(3), gap: 2 },
  warn: { backgroundColor: '#FEF3C7' },
  info: { backgroundColor: colors.brandSoft },
  text: { color: colors.ink, fontWeight: '600' },
  hint: { color: colors.inkSoft, fontSize: 13 },
});
