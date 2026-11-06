import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SLOT_LABEL, addDays, istDate } from '@tiffin/core';
import type { ClosureResult, MealSlot } from '@tiffin/db';
import { cachedFetch, useCacheScope } from '@/lib/cached-fetch';
import { friendlyError } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { closureLabel } from '@/lib/vendor-changes';
import { t } from '@/i18n';
import { Button, Card, Chip, ErrorText, Input, Muted } from './ui';
import { ConfirmBox, DateStepper, kit } from './change-kit';
import { colors, space } from './theme';

type Closure = { id: string; closed_on: string; slot: MealSlot | null; reason: string | null };
type SlotChoice = 'all' | MealSlot;
type Form = { date: string; slot: SlotChoice; reason: string; preview: ClosureResult | null };

const slotArg = (s: SlotChoice) => (s === 'all' ? undefined : s);

/**
 * Kitchen closed days (festivals, holidays) on Today: the upcoming ones, and for the owner "Close
 * tomorrow" / "Close another date" (previewed first: how many meals are not cooked or charged)
 * and Remove. Staff see the list. A closure can only be set while the meal is still open (D-125);
 * the slot cards say "Kitchen closed" for it. `version` changes whenever Today reloads.
 */
export function ClosuresCard({ kitchenId, isOwner, version, onChanged }: {
  kitchenId: string; isOwner: boolean; version?: unknown; onChanged?: () => void;
}) {
  const scope = useCacheScope();
  const today = istDate();
  const [rows, setRows] = useState<Closure[]>([]);
  const [form, setForm] = useState<Form | null>(null);
  const [removing, setRemoving] = useState<Closure | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    void cachedFetch<Closure[]>({
      scope, screen: 'closures',
      fetch: async () => {
        const { data, error: e } = await supabase.from('kitchen_closures').select('id, closed_on, slot, reason')
          .eq('kitchen_id', kitchenId).gte('closed_on', today).order('closed_on').order('slot', { nullsFirst: true }).limit(30);
        return { data: (data ?? []) as Closure[], error: e };
      },
    }).then((res) => {
      if (!alive) return;
      // Offline: the saved list, minus days already past (Today's banner says it is a saved copy).
      if (res.data) setRows(res.data.filter((c) => c.closed_on >= today));
    });
    return () => {
      alive = false;
    };
  }, [scope, kitchenId, today, version, reload]);

  function reset() {
    setError('');
    setSaved('');
  }

  function done(text: string) {
    setSaved(text);
    setForm(null);
    setRemoving(null);
    setReload((n) => n + 1);
    onChanged?.();
  }

  // Every change of date or meal is previewed again (the counts shown are what gets closed).
  async function check(next: Form) {
    reset();
    setRemoving(null);
    setForm({ ...next, preview: null });
    setBusy(true);
    const { data, error: e } = await supabase.rpc('set_kitchen_closure', {
      p_kitchen: kitchenId, p_date: next.date, p_slot: slotArg(next.slot), p_dry_run: true,
    });
    setBusy(false);
    if (e) return setError(friendlyError(e));
    setForm((f) => (f && f.date === next.date && f.slot === next.slot ? { ...f, preview: data as unknown as ClosureResult } : f));
  }

  async function close() {
    if (!form?.preview) return;
    setBusy(true);
    setError('');
    const reason = form.reason.trim();
    const { error: e } = await supabase.rpc('set_kitchen_closure', {
      p_kitchen: kitchenId, p_date: form.date, p_slot: slotArg(form.slot), p_reason: reason || undefined,
    });
    setBusy(false);
    if (e) return setError(friendlyError(e));
    done(t('closure.saved', { label: closureLabel({ closed_on: form.date, slot: slotArg(form.slot) ?? null, reason }) }));
  }

  async function remove() {
    if (!removing) return;
    setBusy(true);
    setError('');
    const { data, error: e } = await supabase.rpc('remove_kitchen_closure', {
      p_kitchen: kitchenId, p_date: removing.closed_on, p_slot: removing.slot ?? undefined,
    });
    setBusy(false);
    if (e) return setError(friendlyError(e));
    done(t('closure.removed', { meals: (data as unknown as ClosureResult | null)?.meals ?? 0 }));
  }

  // Staff with nothing coming up: no card at all.
  if (!isOwner && rows.length === 0) return null;

  return (
    <Card>
      <Text style={styles.title}>{t('closure.title')}</Text>
      {rows.length === 0 && <Muted>{t('closure.none')}</Muted>}
      {rows.map((c) => (
        <View key={c.id} style={styles.item}>
          <View style={kit.row}>
            <Text style={styles.label}>🚫 {closureLabel(c)}</Text>
            {isOwner && removing?.id !== c.id && (
              <Pressable accessibilityRole="button" onPress={() => { reset(); setForm(null); setRemoving(c); }}>
                <Text style={kit.link}>{t('closure.remove')}</Text>
              </Pressable>
            )}
          </View>
          {removing?.id === c.id && (
            <ConfirmBox title={t('closure.removeTitle', { label: closureLabel(c) })}>
              <Muted>{t('closure.removeHint')}</Muted>
              <Button title={t('closure.removeConfirm')} onPress={remove} busy={busy} />
              <Button title={t('actions.back')} onPress={() => setRemoving(null)} variant="secondary" />
            </ConfirmBox>
          )}
        </View>
      ))}

      {isOwner && !form && (
        <View style={kit.chips}>
          <Chip label={t('closure.tomorrow')} selected={false}
            onPress={() => void check({ date: addDays(today, 1), slot: 'all', reason: '', preview: null })} />
          <Chip label={t('closure.date')} selected={false}
            onPress={() => void check({ date: addDays(today, 2), slot: 'all', reason: '', preview: null })} />
        </View>
      )}

      {isOwner && form && (
        <ConfirmBox title={t('closure.formTitle')}>
          <DateStepper label={t('closure.day')} value={form.date} min={today} max={addDays(today, 366)}
            onChange={(d) => void check({ ...form, date: d })} />
          <View style={kit.chips}>
            {(['all', 'lunch', 'dinner'] as const).map((s) => (
              <Chip key={s} label={s === 'all' ? t('closure.whole') : SLOT_LABEL[s]} selected={form.slot === s}
                onPress={() => void check({ ...form, slot: s })} />
            ))}
          </View>
          <Input value={form.reason} maxLength={200} placeholder={t('closure.reason')}
            onChangeText={(v) => setForm((f) => (f ? { ...f, reason: v } : f))} testID="closure-reason" />
          {form.preview ? (
            <>
              <Muted>{t('closure.preview', { meals: form.preview.meals, orders: form.preview.orders })}</Muted>
              <Text style={kit.warn}>{t('closure.tell')}</Text>
            </>
          ) : busy ? <Muted>…</Muted> : null}
          <Button title={t('closure.confirm')} onPress={close} busy={busy} disabled={!form.preview} />
          <Button title={t('actions.back')} onPress={() => { setForm(null); setError(''); }} variant="secondary" />
        </ConfirmBox>
      )}

      {saved ? <Text style={kit.saved}>✓ {saved}</Text> : null}
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 16, fontWeight: '600', color: colors.ink },
  item: { gap: space(2), paddingVertical: space(2), borderTopWidth: 1, borderTopColor: colors.line },
  label: { color: colors.inkSoft, flexShrink: 1 },
});
