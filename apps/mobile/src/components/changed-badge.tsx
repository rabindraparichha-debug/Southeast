import { StyleSheet, Text, View } from 'react-native';
import { formatIstShort } from '@tiffin/core';
import type { RiderStop } from '@/lib/rider-store';
import { showChanged } from '@/lib/vendor-changes';
import { colors, space } from './theme';
import { t } from '@/i18n';

// rider_today returns these per stop (D-121); caches saved by older versions simply lack them.
type WithChange = RiderStop & { changed?: boolean | null; changed_at?: string | null };

/**
 * "Changed" on a stop still to deliver that the kitchen changed after the rider's list was made
 * (a late skip, a new address, a new stop). `detail` adds the explanation, for the stop screen.
 */
export function ChangedBadge({ stop, detail }: { stop: RiderStop; detail?: boolean }) {
  const s = stop as WithChange;
  if (!showChanged(s)) return null;
  const label = s.changed_at ? t('rider.changedAt', { time: formatIstShort(s.changed_at) }) : t('rider.changed');
  if (!detail) return <Text style={styles.badge} testID="stop-changed">⚠ {label}</Text>;
  return (
    <View style={styles.box} testID="stop-changed">
      <Text style={styles.title}>⚠ {label}</Text>
      <Text style={styles.hint}>{t('rider.changedHint')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: 'flex-start', fontSize: 12, fontWeight: '700', color: '#92400E', backgroundColor: '#FEF3C7',
    paddingHorizontal: space(2), paddingVertical: 2, borderRadius: 999, overflow: 'hidden',
  },
  box: { backgroundColor: '#FEF3C7', borderRadius: 10, padding: space(3), gap: space(1) },
  title: { fontSize: 15, fontWeight: '700', color: '#92400E' },
  hint: { fontSize: 14, color: colors.inkSoft },
});
