import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { SLOT_LABEL, addDays, formatServiceDate, istDate } from '@tiffin/core';
import type { ChangeResult } from '@tiffin/db';
import { friendlyError } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { lockedMealChips, lockedMealCounts, mealList, waiveFor, type LockedChip, type MealRow } from '@/lib/vendor-changes';
import { t } from '@/i18n';
import { Button, Card, Chip, ErrorText, Label, Muted } from './ui';
import { CheckRow, ConfirmBox, kit } from './change-kit';

type Pending = { chip: LockedChip; dontCharge: boolean; preview: ChangeResult | null };

function mealText(m: MealRow): string {
  return `${formatServiceDate(m.service_date)} ${SLOT_LABEL[m.slot]}${m.qty > 1 ? ` ×${m.qty}` : ''}`;
}

/**
 * Owner: today's and tomorrow's meals whose count is already frozen. Skipping one is charged
 * (D-116) unless "Don't charge" is ticked, which gives the meal back as one credit; a late skip
 * still charged can be given back the same way. Always previewed first; the rider's list follows
 * by itself (D-121). `version` changes whenever the screen reloads.
 */
export function LockedMealsCard({ customerId, version, onChanged }: { customerId: string; version?: unknown; onChanged?: () => void }) {
  const today = istDate();
  const [rows, setRows] = useState<MealRow[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState(''); // could not load: say so instead of hiding the card
  const [saved, setSaved] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    void supabase
      .from('meal_orders')
      .select('id, subscription_id, service_date, slot, qty, status, charged, charge_waived, locked_at, subscription:subscriptions(status)')
      .eq('customer_id', customerId)
      .gte('service_date', today)
      .lte('service_date', addDays(today, 1))
      .not('locked_at', 'is', null)
      .then(({ data, error: e }) => {
        if (!alive) return;
        setLoadError(e ? t('offline.failed', { error: friendlyError(e) }) : '');
        if (data) setRows(data as MealRow[]);
      });
    return () => {
      alive = false;
    };
  }, [customerId, today, version, reload]);

  const chips = lockedMealChips(rows, today);

  const args = (chip: LockedChip, dontCharge: boolean, dryRun: boolean) => ({
    p_subscription: chip.meal.subscription_id, p_type: 'skip' as const, p_from: chip.meal.service_date,
    p_to: chip.meal.service_date, p_slot: chip.meal.slot, p_waive_late: waiveFor(chip.action, dontCharge), p_dry_run: dryRun,
  });

  async function preview(chip: LockedChip, dontCharge: boolean) {
    setError('');
    setSaved('');
    setPending({ chip, dontCharge, preview: null });
    setBusy(true);
    const { data, error: e } = await supabase.rpc('request_schedule_change', args(chip, dontCharge, true));
    setBusy(false);
    if (e) {
      setPending(null);
      return setError(friendlyError(e));
    }
    setPending((p) => (p && p.chip.meal.id === chip.meal.id && p.dontCharge === dontCharge ? { ...p, preview: data as unknown as ChangeResult } : p));
  }

  async function confirm() {
    if (!pending?.preview) return;
    setBusy(true);
    setError('');
    const { error: e } = await supabase.rpc('request_schedule_change', args(pending.chip, pending.dontCharge, false));
    setBusy(false);
    if (e) return setError(friendlyError(e));
    const m = mealText(pending.chip.meal);
    setSaved(`${pending.chip.action === 'waive' ? t('locked.waive', { meal: m }) : t('locked.skip', { meal: m })} · ${t('actions.saved')}`);
    setPending(null);
    setReload((n) => n + 1);
    onChanged?.();
  }

  if (!chips.length && !saved && !error && !loadError) return null;
  const shown = pending?.preview ?? null;
  // One order per preview: the meal counts follow its qty (the lock charges and credits all of it).
  const counts = shown && pending ? { total: shown.affected.length, ...lockedMealCounts(shown.affected, pending.chip.meal.qty) } : null;
  const chipLabel = (c: LockedChip) =>
    c.action === 'waive' ? t('locked.waive', { meal: mealText(c.meal) }) : t('locked.skip', { meal: mealText(c.meal) });

  return (
    <Card>
      <Label>{t('locked.title')}</Label>
      <ErrorText>{loadError}</ErrorText>
      {chips.length > 0 && <Text style={kit.small}>{t('locked.hint')}</Text>}
      {chips.length > 0 && (
        <View style={kit.chips}>
          {chips.map((c) => (
            <Chip key={`${c.meal.id}-${c.action}`} label={chipLabel(c)} selected={pending?.chip.meal.id === c.meal.id}
              onPress={() => void preview(c, false)} />
          ))}
        </View>
      )}
      {pending && (
        <ConfirmBox title={chipLabel(pending.chip)}>
          {!shown || !counts ? (
            <Muted>…</Muted>
          ) : counts.total === 0 ? (
            <Muted>{t('actions.noneAffected')}</Muted>
          ) : (
            <>
              <Muted>{t('actions.affects', { meals: mealList(shown.affected) })}</Muted>
              {counts.charged > 0 && <Text style={kit.warn}>{t('locked.charged', { n: counts.charged })}</Text>}
              {counts.credited > 0 && <Text style={kit.good}>{t('locked.credited', { n: counts.credited })}</Text>}
            </>
          )}
          {pending.chip.action === 'skip' && (
            <CheckRow checked={pending.dontCharge} disabled={busy} label={t('locked.dontCharge')}
              onToggle={() => void preview(pending.chip, !pending.dontCharge)} />
          )}
          {pending.chip.action === 'skip' && <Text style={kit.small}>{t('locked.rider')}</Text>}
          <Button title={t('actions.confirm')} onPress={confirm} busy={busy} disabled={!counts || counts.total === 0} />
          <Button title={t('actions.back')} onPress={() => setPending(null)} variant="secondary" />
        </ConfirmBox>
      )}
      {saved ? <Text style={kit.saved}>✓ {saved}</Text> : null}
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}
