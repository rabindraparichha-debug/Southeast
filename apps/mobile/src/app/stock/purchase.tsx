import * as ImagePicker from 'expo-image-picker';
import { Image } from 'expo-image';
import { Redirect, router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { addDays, formatPaise, istDate, rupeesToPaise } from '@tiffin/core';
import { Button, Card, Chip, ErrorText, Input, Label, Muted } from '@/components/ui';
import { ItemPicker, UnitChips } from '@/components/stock-ui';
import { colors, radius, space } from '@/components/theme';
import { friendlyError } from '@/lib/errors';
import { uuid } from '@/lib/rider-store';
import { useKitchen } from '@/lib/session';
import { convertQty, parseQty, readPhotoBytes, type PurchaseResult, type StockRow, type StockUnit } from '@/lib/stock';
import { supabase } from '@/lib/supabase';
import { t } from '@/i18n';

type Supplier = { id: string; name: string };
type Line = { key: string; item: StockRow; qty: string; unit: StockUnit; amount: string };
type Photo = { uri: string; path: string; uploaded: boolean };

/** Price per unit of the item for the hint under a line, or null while the line is incomplete. */
function unitPrice(line: Line): number | null {
  const qty = parseQty(line.qty);
  const paise = rupeesToPaise(line.amount);
  if (!qty || paise == null) return null;
  const inItemUnit = convertQty(qty, line.unit, line.item.unit);
  return inItemUnit > 0 ? Math.round(paise / inItemUnit) : null;
}

// A supplier bill in under a minute: supplier, photo, items with quantity and amount, save.
export default function Purchase() {
  const kitchen = useKitchen();
  const isOwner = kitchen.role === 'owner';
  const today = istDate();

  const [items, setItems] = useState<StockRow[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [newSupplier, setNewSupplier] = useState<string | null>(null); // null: not adding
  const [billDate, setBillDate] = useState(today);
  const [billNo, setBillNo] = useState('');
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [picking, setPicking] = useState(true);
  const [paidNow, setPaidNow] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<PurchaseResult | null>(null);

  const loadSuppliers = useCallback(async () => {
    const { data } = await supabase.from('suppliers').select('id, name').eq('kitchen_id', kitchen.kitchenId).eq('active', true).order('name');
    setSuppliers(data ?? []);
  }, [kitchen.kitchenId]);

  const loadItems = useCallback(async () => {
    const { data, error: e } = await supabase.rpc('stock_levels', { p_kitchen: kitchen.kitchenId });
    if (e) setError(friendlyError(e));
    setItems((data ?? []).filter((i) => i.active).sort((a, b) => a.name.localeCompare(b.name)));
  }, [kitchen.kitchenId]);

  useFocusEffect(
    useCallback(() => {
      if (kitchen.role === 'rider') return;
      void loadSuppliers();
      void loadItems();
    }, [kitchen.role, loadSuppliers, loadItems]),
  );

  const available = useMemo(() => items.filter((i) => !lines.some((l) => l.item.item_id === i.item_id)), [items, lines]);
  const totalPaise = lines.reduce((sum, l) => sum + (rupeesToPaise(l.amount) ?? 0), 0);

  if (kitchen.role === 'rider') return <Redirect href="/rider" />;

  const update = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const addSupplier = async () => {
    setError('');
    if (!newSupplier?.trim()) return setError(t('errors.name_required'));
    const { data, error: e } = await supabase.rpc('upsert_supplier', { p_kitchen: kitchen.kitchenId, p_name: newSupplier.trim() });
    if (e || !data) return setError(e?.message === 'already_exists' ? t('stock.purchase.supplierExists') : friendlyError(e));
    await loadSuppliers();
    setSupplierId(data);
    setNewSupplier(null);
  };

  const takePhoto = async () => {
    setError('');
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) return setError(t('stock.purchase.cameraDenied'));
      const shot = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.5, allowsEditing: false, exif: false });
      if (shot.canceled || !shot.assets[0]) return;
      setPhoto({ uri: shot.assets[0].uri, path: `${kitchen.kitchenId}/${billDate}-${uuid()}.jpg`, uploaded: false });
    } catch {
      setError(t('stock.purchase.cameraFailed'));
    }
  };

  const save = async () => {
    setError('');
    if (lines.length === 0) return setError(t('errors.no_lines'));
    const payload: { item_id: string; qty: number; unit: StockUnit; amount_paise: number }[] = [];
    for (const l of lines) {
      const qty = parseQty(l.qty);
      if (!qty) return setError(`${l.item.name}: ${t('errors.invalid_qty')}`);
      const amount = rupeesToPaise(l.amount);
      if (amount == null) return setError(`${l.item.name}: ${t('errors.invalid_bill_amount')}`);
      payload.push({ item_id: l.item.item_id, qty, unit: l.unit, amount_paise: amount });
    }
    let paid = 0;
    if (isOwner && supplierId && paidNow.trim()) {
      const p = rupeesToPaise(paidNow);
      if (p == null) return setError(t('errors.invalid_amount'));
      paid = p;
    }
    setBusy(true);
    if (photo && !photo.uploaded) {
      setStatus(t('stock.purchase.uploading'));
      try {
        const bytes = await readPhotoBytes(photo.uri);
        const { error: up } = await supabase.storage.from('bills').upload(photo.path, bytes, { contentType: 'image/jpeg' });
        // A retry after a lost response finds the photo already there: that is fine.
        if (up && !/exist|duplicate/i.test(up.message)) throw new Error(up.message);
        setPhoto({ ...photo, uploaded: true });
      } catch (e) {
        setBusy(false);
        setStatus('');
        return setError(`${t('errors.invalid_photo')} (${(e as Error).message})`);
      }
      setStatus('');
    }
    const { data, error: e } = await supabase.rpc('record_purchase', {
      p_kitchen: kitchen.kitchenId,
      p_lines: payload,
      p_supplier: supplierId ?? undefined,
      p_bill_date: billDate,
      p_bill_no: billNo.trim() || undefined,
      p_photo_path: photo?.path,
      p_paid_now_paise: paid,
    });
    setBusy(false);
    if (e) return setError(friendlyError(e));
    setResult(data as unknown as PurchaseResult);
  };

  const reset = () => {
    setResult(null);
    setLines([]);
    setPicking(true);
    setPhoto(null);
    setBillNo('');
    setPaidNow('');
    setError('');
  };

  if (result) {
    const unitOf = (name: string) => items.find((i) => i.name === name)?.unit ?? '';
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Card>
          <Text style={styles.savedTitle} testID="purchase-saved">✓ {t('stock.purchase.savedTotal', { amount: formatPaise(result.total_paise) })}</Text>
        </Card>
        {result.price_jumps.length > 0 && (
          <Card style={styles.warn}>
            <Text style={styles.warnTitle}>⚠️ {t('stock.purchase.priceJumps')}</Text>
            {result.price_jumps.map((j) => (
              <Text key={j.item} style={styles.warnText} testID="price-jump">
                {isOwner
                  ? t('stock.purchase.jump', { item: j.item, from: formatPaise(j.from_paise), to: formatPaise(j.to_paise), unit: unitOf(j.item), pct: Math.round(j.pct) })
                  : t('stock.purchase.jumpPct', { item: j.item, pct: Math.round(j.pct) })}
              </Text>
            ))}
          </Card>
        )}
        <Button title={t('stock.done')} onPress={() => router.back()} />
        <Button title={t('stock.purchase.another')} variant="secondary" onPress={reset} />
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Card>
        <Label>{t('stock.purchase.supplier')}</Label>
        <View style={styles.chips}>
          <Chip label={t('stock.purchase.noSupplier')} selected={supplierId === null} onPress={() => setSupplierId(null)} />
          {suppliers.map((s) => <Chip key={s.id} label={s.name} selected={supplierId === s.id} onPress={() => setSupplierId(s.id)} />)}
          {newSupplier === null && <Chip label={t('stock.purchase.newSupplier')} selected={false} onPress={() => setNewSupplier('')} />}
        </View>
        {newSupplier !== null && (
          <View style={styles.row}>
            <Input style={{ flex: 1, minWidth: 0 }} value={newSupplier} onChangeText={setNewSupplier} placeholder={t('stock.purchase.supplierName')} autoFocus />
            <Button title={t('stock.purchase.addSupplier')} variant="secondary" onPress={addSupplier} />
          </View>
        )}
        <Label>{t('stock.purchase.billDate')}</Label>
        <View style={styles.chips}>
          <Chip label={t('stock.purchase.today')} selected={billDate === today} onPress={() => setBillDate(today)} />
          <Chip label={t('stock.purchase.yesterday')} selected={billDate === addDays(today, -1)} onPress={() => setBillDate(addDays(today, -1))} />
        </View>
        <Input value={billNo} onChangeText={setBillNo} placeholder={t('stock.purchase.billNo')} testID="bill-no" />
      </Card>

      <Card>
        <Label>{t('stock.purchase.photo')}</Label>
        {photo ? (
          <View style={styles.row}>
            <Image source={{ uri: photo.uri }} style={styles.thumb} contentFit="cover" />
            <View style={{ flex: 1, gap: space(2) }}>
              <Button title={t('stock.purchase.retake')} variant="secondary" onPress={takePhoto} disabled={busy} />
              <Button title={t('stock.purchase.removePhoto')} variant="secondary" onPress={() => setPhoto(null)} disabled={busy} />
            </View>
          </View>
        ) : (
          <Button title={`📷 ${t('stock.purchase.takePhoto')}`} variant="secondary" onPress={takePhoto} />
        )}
      </Card>

      <Card>
        <Label>{t('stock.purchase.items')}</Label>
        {lines.map((l) => {
          const price = unitPrice(l);
          return (
            <View key={l.key} style={styles.line} testID={`line-${l.item.name}`}>
              <View style={styles.row}>
                <Text style={styles.lineName}>{l.item.name}</Text>
                <Pressable onPress={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} accessibilityRole="button">
                  <Text style={styles.remove}>{t('stock.purchase.remove')}</Text>
                </Pressable>
              </View>
              <View style={styles.row}>
                <Input style={styles.qtyInput} value={l.qty} onChangeText={(v) => update(l.key, { qty: v })} keyboardType="decimal-pad" placeholder={t('stock.qty')} testID={`qty-${l.item.name}`} />
                <UnitChips itemUnit={l.item.unit} value={l.unit} onChange={(u) => update(l.key, { unit: u })} />
              </View>
              <View style={styles.row}>
                <Text style={styles.rupee}>₹</Text>
                <Input style={{ flex: 1, minWidth: 0 }} value={l.amount} onChangeText={(v) => update(l.key, { amount: v })} keyboardType="decimal-pad" placeholder={t('stock.purchase.amount')} testID={`amount-${l.item.name}`} />
              </View>
              {price != null && <Muted>{t('stock.purchase.perUnit', { price: formatPaise(price), unit: l.item.unit })}</Muted>}
            </View>
          );
        })}
        {picking ? (
          <ItemPicker
            items={available}
            limit={6}
            onPick={(item) => {
              setLines((ls) => [...ls, { key: uuid(), item, qty: '', unit: item.unit, amount: '' }]);
              setPicking(false);
            }}
          />
        ) : (
          <Button title={t('stock.purchase.addItem')} variant="secondary" onPress={() => setPicking(true)} />
        )}
      </Card>

      <Card>
        <Text style={styles.total} testID="purchase-total">{t('stock.purchase.total', { amount: formatPaise(totalPaise) })}</Text>
        {isOwner && supplierId && (
          <>
            <Label>{t('stock.purchase.paidNow')}</Label>
            <Input value={paidNow} onChangeText={setPaidNow} keyboardType="decimal-pad" placeholder="0" />
            <Muted>{t('stock.purchase.paidNowHint')}</Muted>
          </>
        )}
        {status ? <Muted>{status}</Muted> : null}
        <ErrorText>{error}</ErrorText>
        <Button title={t('stock.purchase.save')} onPress={save} busy={busy} disabled={lines.length === 0} />
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space(4), gap: space(3), paddingBottom: space(12) },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  row: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  thumb: { width: 96, height: 128, borderRadius: radius, backgroundColor: colors.line },
  line: { gap: space(2), paddingBottom: space(3), borderBottomWidth: 1, borderBottomColor: colors.line },
  lineName: { flex: 1, fontSize: 16, fontWeight: '600', color: colors.ink },
  remove: { color: colors.danger, fontSize: 14 },
  qtyInput: { flex: 1, minWidth: 0 },
  rupee: { fontSize: 18, fontWeight: '600', color: colors.inkSoft, width: 16, textAlign: 'center' },
  total: { fontSize: 18, fontWeight: '700', color: colors.ink },
  savedTitle: { fontSize: 18, fontWeight: '600', color: colors.veg },
  warn: { backgroundColor: '#FEF3C7', borderColor: '#FCD34D' },
  warnTitle: { fontSize: 16, fontWeight: '600', color: colors.ink },
  warnText: { fontSize: 15, color: colors.inkSoft },
});
