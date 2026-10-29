import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatQty, unitsFor, type StockRow, type StockUnit } from '@/lib/stock';
import { Chip, Input } from './ui';
import { colors, radius, space } from './theme';
import { t } from '@/i18n';

/** Search-as-you-type item list for quick entry. Shows at most `limit` matches. */
export function ItemPicker({ items, onPick, limit = 8, autoFocus }: {
  items: StockRow[]; onPick: (item: StockRow) => void; limit?: number; autoFocus?: boolean;
}) {
  const [q, setQ] = useState('');
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    return items.filter((i) => i.active && (!s || i.name.toLowerCase().includes(s))).slice(0, limit);
  }, [items, q, limit]);
  return (
    <View style={styles.picker}>
      <Input value={q} onChangeText={setQ} placeholder={t('stock.search')} autoFocus={autoFocus} testID="item-search" />
      {matches.length === 0 && <Text style={styles.empty}>{t('stock.noMatch')}</Text>}
      {matches.map((i) => (
        <Pressable key={i.item_id} onPress={() => onPick(i)} style={({ pressed }) => [styles.option, pressed && { opacity: 0.7 }]} accessibilityRole="button" testID={`pick-${i.name}`}>
          <Text style={styles.optionName}>{i.name}</Text>
          <Text style={[styles.optionStock, i.low && { color: colors.danger }]}>{formatQty(i.stock)} {i.unit}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/** kg/g, l/ml chips (nothing to choose for pieces). */
export function UnitChips({ itemUnit, value, onChange }: { itemUnit: StockUnit; value: StockUnit; onChange: (u: StockUnit) => void }) {
  const units = unitsFor(itemUnit);
  if (units.length < 2) return <Text style={styles.unitOnly}>{itemUnit}</Text>;
  return (
    <View style={styles.units}>
      {units.map((u) => <Chip key={u} label={u} selected={value === u} onPress={() => onChange(u)} />)}
    </View>
  );
}

export function LowBadge() {
  return <Text style={styles.low}>{t('stock.low')}</Text>;
}

const styles = StyleSheet.create({
  picker: { gap: space(1) },
  option: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space(3), paddingVertical: space(3), backgroundColor: '#fff', borderRadius: radius, borderWidth: 1, borderColor: colors.line },
  optionName: { flex: 1, fontSize: 16, color: colors.ink },
  optionStock: { fontSize: 14, color: colors.muted },
  empty: { color: colors.muted, padding: space(2) },
  units: { flexDirection: 'row', gap: space(2) },
  unitOnly: { fontSize: 16, color: colors.inkSoft, paddingHorizontal: space(2) },
  low: { fontSize: 12, fontWeight: '700', color: '#fff', backgroundColor: colors.danger, borderRadius: 999, paddingHorizontal: space(2), paddingVertical: 2, overflow: 'hidden' },
});
