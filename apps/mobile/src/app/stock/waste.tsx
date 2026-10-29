import { Redirect, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, Card, Chip, ErrorText, Input, Label, Muted } from '@/components/ui';
import { ItemPicker, UnitChips } from '@/components/stock-ui';
import { colors, space } from '@/components/theme';
import { friendlyError } from '@/lib/errors';
import { useKitchen } from '@/lib/session';
import { formatQty, parseQty, type StockRow, type StockUnit } from '@/lib/stock';
import { supabase } from '@/lib/supabase';
import { t } from '@/i18n';

// Stored as plain English words so reports read the same whatever language the app is in.
const REASONS = [
  { key: 'spoiled', value: 'Spoiled' },
  { key: 'burnt', value: 'Burnt' },
  { key: 'spilled', value: 'Spilled' },
  { key: 'leftover', value: 'Leftover' },
  { key: 'other', value: 'Other' },
] as const;
type ReasonKey = (typeof REASONS)[number]['key'];

export default function Waste() {
  const kitchen = useKitchen();
  const params = useLocalSearchParams<{ item?: string }>();
  const [items, setItems] = useState<StockRow[]>([]);
  const [item, setItem] = useState<StockRow | null>(null);
  const [qty, setQty] = useState('');
  const [unit, setUnit] = useState<StockUnit>('kg');
  const [reason, setReason] = useState<ReasonKey | null>(null);
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  const load = async (keep?: string) => {
    const { data, error: e } = await supabase.rpc('stock_levels', { p_kitchen: kitchen.kitchenId });
    if (e) return setError(friendlyError(e));
    const list = (data ?? []).filter((i) => i.active).sort((a, b) => a.name.localeCompare(b.name));
    setItems(list);
    const want = keep ?? params.item;
    if (want) {
      const found = list.find((i) => i.item_id === want);
      if (found) {
        setItem(found);
        if (!keep) setUnit(found.unit);
      }
    }
  };

  useFocusEffect(
    useCallback(() => {
      if (kitchen.role !== 'rider') void load();
    }, [kitchen.kitchenId]), // eslint-disable-line react-hooks/exhaustive-deps
  );

  if (kitchen.role === 'rider') return <Redirect href="/rider" />;

  const pick = (i: StockRow) => {
    setItem(i);
    setUnit(i.unit);
    setSaved('');
    setError('');
  };

  const save = async () => {
    setError('');
    setSaved('');
    if (!item) return setError(t('stock.pickItem'));
    const n = parseQty(qty);
    if (!n) return setError(t('errors.invalid_qty'));
    if (!reason) return setError(t('errors.reason_required'));
    if (reason === 'other' && !other.trim()) return setError(t('errors.note_required'));
    const text = reason === 'other' ? other.trim() : REASONS.find((r) => r.key === reason)!.value;
    setBusy(true);
    const { error: e } = await supabase.rpc('record_waste', { p_item: item.item_id, p_qty: n, p_reason: text, p_unit: unit });
    setBusy(false);
    if (e) return setError(friendlyError(e));
    setSaved(t('stock.waste.saved', { qty: formatQty(n), unit, item: item.name, reason: reason === 'other' ? text : t(`stock.waste.reason.${reason}`) }));
    setQty('');
    setReason(null);
    setOther('');
    void load(item.item_id); // fresh stock figure
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {saved ? (
        <Card>
          <Text style={styles.saved} testID="waste-saved">✓ {saved}</Text>
          <View style={styles.row}>
            <View style={{ flex: 1 }}><Button title={t('stock.done')} onPress={() => router.back()} /></View>
            <View style={{ flex: 1 }}><Button title={t('stock.waste.another')} variant="secondary" onPress={() => { setSaved(''); setItem(null); }} /></View>
          </View>
        </Card>
      ) : null}

      <Card>
        <Label>{t('stock.pickItem')}</Label>
        {item ? (
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.itemName} testID="waste-item">{item.name}</Text>
              <Muted>{t('stock.inStock', { qty: formatQty(item.stock), unit: item.unit })}</Muted>
            </View>
            <Pressable onPress={() => setItem(null)} accessibilityRole="button"><Text style={styles.link}>{t('stock.change')}</Text></Pressable>
          </View>
        ) : (
          <ItemPicker items={items} onPick={pick} />
        )}
      </Card>

      {item && (
        <Card>
          <Label>{t('stock.qty')}</Label>
          <View style={styles.row}>
            <Input style={{ flex: 1, minWidth: 0 }} value={qty} onChangeText={setQty} keyboardType="decimal-pad" placeholder="0" testID="waste-qty" />
            <UnitChips itemUnit={item.unit} value={unit} onChange={setUnit} />
          </View>
          <Label>{t('stock.waste.reason')}</Label>
          <View style={styles.chips}>
            {REASONS.map((r) => <Chip key={r.key} label={t(`stock.waste.reason.${r.key}`)} selected={reason === r.key} onPress={() => setReason(r.key)} />)}
          </View>
          {reason === 'other' && <Input value={other} onChangeText={setOther} placeholder={t('stock.waste.otherText')} maxLength={200} testID="waste-other" />}
          <ErrorText>{error}</ErrorText>
          <Button title={t('stock.waste.save')} onPress={save} busy={busy} />
        </Card>
      )}
      {!item && <ErrorText>{error}</ErrorText>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space(4), gap: space(3), paddingBottom: space(12) },
  row: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  itemName: { fontSize: 18, fontWeight: '600', color: colors.ink },
  link: { color: colors.brand, fontSize: 15, fontWeight: '500' },
  saved: { fontSize: 16, fontWeight: '600', color: colors.veg },
});
