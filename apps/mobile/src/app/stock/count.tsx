import { Redirect, router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { formatIstShort } from '@tiffin/core';
import { Button, Card, ErrorText, Input, Muted } from '@/components/ui';
import { UnitChips } from '@/components/stock-ui';
import { colors, space } from '@/components/theme';
import { friendlyError } from '@/lib/errors';
import { useKitchen } from '@/lib/session';
import { convertQty, formatQty, formatVariance, parseQty, type CountResult, type ReviewLine, type StockTakeReview, type StockUnit } from '@/lib/stock';
import { supabase } from '@/lib/supabase';
import { t } from '@/i18n';

type Entry = { counted: string; unit: StockUnit; reason: string; saving: boolean; error: string };

/** Typed count converted to the item's unit, or undefined when empty, or null when not a number. */
function typedQty(e: Entry, line: ReviewLine): number | null | undefined {
  if (!e.counted.trim()) return undefined;
  const n = parseQty(e.counted);
  return n == null ? null : Math.round(convertQty(n, e.unit, line.unit) * 1000) / 1000;
}

// Count what is in the kitchen, item by item. Big differences need a reason before closing.
export default function StockCount() {
  const kitchen = useKitchen();
  const [loading, setLoading] = useState(true);
  const [take, setTake] = useState<StockTakeReview | null>(null);
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [closedMsg, setClosedMsg] = useState('');

  const review = useCallback(async (id: string) => {
    const { data, error: e } = await supabase.rpc('stock_take_review', { p_stock_take: id });
    if (e) return setError(friendlyError(e));
    const r = data as unknown as StockTakeReview;
    r.lines.sort((a, b) => a.item.localeCompare(b.item)); // stable order while counting
    setTake(r);
    setEntries((prev) => {
      const next = { ...prev };
      for (const l of r.lines) {
        if (!next[l.item_id]) {
          next[l.item_id] = { counted: l.counted != null ? formatQty(l.counted) : '', unit: l.unit, reason: l.reason ?? '', saving: false, error: '' };
        }
      }
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const { data, error: e } = await supabase
      .from('stock_takes').select('id').eq('kitchen_id', kitchen.kitchenId).eq('status', 'open').maybeSingle();
    if (e) setError(friendlyError(e));
    if (data) await review(data.id);
    else setTake(null);
    setLoading(false);
  }, [kitchen.kitchenId, review]);

  useFocusEffect(
    useCallback(() => {
      if (kitchen.role !== 'rider') void load();
    }, [kitchen.role, load]),
  );

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (take?.lines ?? []).filter((l) => !s || l.item.toLowerCase().includes(s));
  }, [take, q]);

  if (kitchen.role === 'rider') return <Redirect href="/rider" />;

  const patch = (itemId: string, p: Partial<Entry>) => setEntries((es) => ({ ...es, [itemId]: { ...es[itemId], ...p } }));
  const patchLine = (itemId: string, p: Partial<ReviewLine>) =>
    setTake((tk) => (tk ? { ...tk, lines: tk.lines.map((l) => (l.item_id === itemId ? { ...l, ...p } : l)) } : tk));

  const start = async () => {
    setBusy(true);
    setError('');
    const { data, error: e } = await supabase.rpc('start_stock_take', { p_kitchen: kitchen.kitchenId });
    if (e || !data) {
      setBusy(false);
      return setError(friendlyError(e));
    }
    await review(data);
    setBusy(false);
  };

  /** Saves one row when its count or reason changed. Returns false when the row has a problem. */
  const saveRow = async (line: ReviewLine, entry: Entry): Promise<boolean> => {
    if (!take) return false;
    const qty = typedQty(entry, line);
    if (qty === undefined) return true; // not counted yet
    if (qty === null) {
      patch(line.item_id, { error: t('errors.invalid_qty') });
      return false;
    }
    const reason = entry.reason.trim();
    if (qty === line.counted && (!reason || reason === line.reason)) return true; // nothing new
    patch(line.item_id, { saving: true, error: '' });
    const { data, error: e } = await supabase.rpc('set_stock_count', {
      p_stock_take: take.id, p_item: line.item_id, p_counted: parseQty(entry.counted)!, p_unit: entry.unit, p_reason: reason || undefined,
    });
    if (e) {
      patch(line.item_id, { saving: false, error: friendlyError(e) });
      return false;
    }
    const r = data as unknown as CountResult;
    patch(line.item_id, { saving: false });
    patchLine(line.item_id, { expected: r.expected, counted: r.counted, variance: r.variance, needs_reason: r.needs_reason, reason: reason || line.reason });
    return true;
  };

  const close = async () => {
    if (!take) return;
    setError('');
    setBusy(true);
    // Save anything still being typed (the last field may not have lost focus yet).
    const results = await Promise.all(take.lines.map((l) => saveRow(l, entries[l.item_id])));
    if (results.some((ok) => !ok)) {
      setBusy(false);
      return setError(t('errors.invalid_qty'));
    }
    const { data, error: e } = await supabase.rpc('close_stock_take', { p_stock_take: take.id });
    setBusy(false);
    if (e) {
      setError(e.message === 'reason_required' ? t('stock.count.reasonRequired') : friendlyError(e));
      if (e.message === 'reason_required' || e.message === 'stock_take_closed') await review(take.id);
      return;
    }
    setClosedMsg(t('stock.count.closed', { n: (data as { adjustments?: number } | null)?.adjustments ?? 0 }));
  };

  if (loading) {
    return <View style={[styles.screen, styles.center]}><ActivityIndicator color={colors.brand} /></View>;
  }

  if (closedMsg) {
    return (
      <View style={[styles.screen, styles.content]}>
        <Card>
          <Text style={styles.ok} testID="count-closed">✓ {closedMsg}</Text>
        </Card>
        <Button title={t('stock.done')} onPress={() => router.back()} />
      </View>
    );
  }

  if (!take || take.status !== 'open') {
    return (
      <View style={[styles.screen, styles.content]}>
        <Card>
          <Muted>{t('stock.count.none')}</Muted>
          <ErrorText>{error}</ErrorText>
          <Button title={t('stock.count.start')} onPress={start} busy={busy} />
        </Card>
      </View>
    );
  }

  const counted = take.lines.filter((l) => l.counted != null).length;
  const missing = take.lines.filter((l) => l.needs_reason).length;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Card>
        <Text style={styles.progress} testID="count-progress">{t('stock.count.progress', { done: counted, total: take.lines.length })}</Text>
        <Muted>{t('stock.count.started', { time: formatIstShort(take.started_at) })}</Muted>
        <Muted>{t('stock.count.hint')}</Muted>
      </Card>
      <Input value={q} onChangeText={setQ} placeholder={t('stock.search')} clearButtonMode="while-editing" testID="count-search" />

      {shown.map((line) => {
        const e = entries[line.item_id];
        if (!e) return null;
        const showReason = line.needs_reason || Boolean(line.reason);
        return (
          <Card key={line.item_id} style={line.needs_reason ? styles.needs : undefined}>
            <View style={styles.row} testID={`count-row-${line.item}`}>
              <Text style={styles.itemName}>{line.item}</Text>
              {e.saving && <Muted>{t('stock.count.saving')}</Muted>}
              {line.needs_reason && !e.saving && <Text style={styles.needsBadge}>{t('stock.count.needsReason')}</Text>}
            </View>
            <View style={styles.row}>
              <Input
                style={styles.qtyInput}
                value={e.counted}
                onChangeText={(v) => patch(line.item_id, { counted: v, error: '' })}
                onBlur={() => void saveRow(line, e)}
                onSubmitEditing={() => void saveRow(line, e)}
                keyboardType="decimal-pad"
                placeholder={t('stock.qty')}
                testID={`count-${line.item}`}
              />
              <UnitChips
                itemUnit={line.unit}
                value={e.unit}
                onChange={(u) => {
                  patch(line.item_id, { unit: u });
                  void saveRow(line, { ...e, unit: u });
                }}
              />
            </View>
            {line.counted != null && line.variance != null && (
              <Text style={[styles.variance, line.needs_reason ? { color: colors.danger } : null]} testID={`variance-${line.item}`}>
                {t('stock.count.book', { qty: formatQty(line.expected), unit: line.unit })} · {Math.abs(line.variance) < 0.0005
                  ? t('stock.count.match')
                  : t('stock.count.variance', { variance: formatVariance(line.variance, line.unit) })}
              </Text>
            )}
            {showReason && (
              <>
                <Text style={styles.reasonLabel}>{t('stock.count.reason')}</Text>
                <Input
                  value={e.reason}
                  onChangeText={(v) => patch(line.item_id, { reason: v })}
                  onBlur={() => void saveRow(line, e)}
                  onSubmitEditing={() => void saveRow(line, e)}
                  placeholder={t('stock.count.reasonPlaceholder')}
                  maxLength={200}
                  testID={`reason-${line.item}`}
                />
              </>
            )}
            <ErrorText>{e.error}</ErrorText>
          </Card>
        );
      })}

      <Card>
        <Muted>{t('stock.count.closeHint')}</Muted>
        {missing > 0 && <Text style={styles.missing}>{t('stock.count.needsReason')}: {missing}</Text>}
        <ErrorText>{error}</ErrorText>
        <Button title={t('stock.count.close')} onPress={close} busy={busy} />
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: { alignItems: 'center', justifyContent: 'center' },
  content: { padding: space(4), gap: space(3), paddingBottom: space(12) },
  row: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  progress: { fontSize: 16, fontWeight: '600', color: colors.ink },
  itemName: { flex: 1, fontSize: 16, fontWeight: '600', color: colors.ink },
  qtyInput: { flex: 1, minWidth: 0 },
  variance: { fontSize: 14, color: colors.muted },
  needs: { borderColor: colors.danger },
  needsBadge: { fontSize: 12, fontWeight: '700', color: colors.danger },
  reasonLabel: { fontSize: 14, fontWeight: '500', color: colors.danger },
  missing: { fontSize: 14, fontWeight: '600', color: colors.danger },
  ok: { fontSize: 16, fontWeight: '600', color: colors.veg },
});
