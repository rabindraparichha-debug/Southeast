import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { addDays, formatServiceDate, istDate } from '@tiffin/core';
import type { ChangeResult, ReactivateResult, SubscriptionStatus } from '@tiffin/db';
import { friendlyError } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import {
  cancelFromDefault, holdLabel, mealList, previewCounts, reactivatedWithoutBalance, sortSubscriptions, subscriptionActions,
  type Hold,
} from '@/lib/vendor-changes';
import { t } from '@/i18n';
import { Button, Card, Chip, ErrorText, Label, Muted } from './ui';
import { Badge, ConfirmBox, DateStepper, STATUS_TONE, kit } from './change-kit';

type Sub = {
  id: string; status: SubscriptionStatus; qty: number; start_date: string; end_date: string | null; created_at: string;
  plan: { name: string } | null;
};

type Pending =
  | { kind: 'undo'; subId: string; hold: Hold; preview: ChangeResult }
  | { kind: 'cancel'; subId: string; from: string; preview: ChangeResult | null }
  | { kind: 'reactivate'; subId: string; from: string };

/**
 * Owner: every subscription with a clear status badge; its upcoming skips and pauses as chips with
 * Undo (preview first); Cancel (preview first, then a second confirm) and Reactivate for a
 * cancelled one. `version` changes whenever the screen reloads, so this card reloads with it.
 */
export function SubscriptionsCard({ customerId, kitchenId, version, onChanged }: {
  customerId: string; kitchenId: string; version?: unknown; onChanged?: () => void;
}) {
  const today = istDate();
  const [subs, setSubs] = useState<Sub[] | null>(null);
  const [holds, setHolds] = useState<Record<string, Hold[]>>({});
  const [noticeDays, setNoticeDays] = useState(1);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<{ text: string; warn: boolean } | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [s, k] = await Promise.all([
        supabase.from('subscriptions').select('id, status, qty, start_date, end_date, created_at, plan:plans(name)').eq('customer_id', customerId),
        supabase.from('kitchen_settings').select('notice_days').eq('kitchen_id', kitchenId).maybeSingle(),
      ]);
      if (!alive) return;
      if (s.error) return setError(friendlyError(s.error));
      const list = sortSubscriptions((s.data ?? []) as Sub[]);
      setSubs(list);
      setNoticeDays(k.data?.notice_days ?? 1);
      const live = list.filter((x) => subscriptionActions(x.status).holds);
      const results = await Promise.all(live.map((x) => supabase.rpc('subscription_holds', { p_subscription: x.id })));
      if (!alive) return;
      const map: Record<string, Hold[]> = {};
      live.forEach((x, i) => {
        map[x.id] = (results[i]?.data ?? []) as unknown as Hold[];
      });
      setHolds(map);
    })();
    return () => {
      alive = false;
    };
  }, [customerId, kitchenId, version, reload]);

  function start() {
    setError('');
    setSaved(null);
  }

  function finish(text: string, warn = false) {
    setPending(null);
    setSaved({ text, warn });
    setReload((n) => n + 1);
    onChanged?.();
  }

  async function previewUndo(subId: string, hold: Hold) {
    start();
    setBusy(true);
    const { data, error: e } = await supabase.rpc('revoke_schedule_change', { p_change: hold.change_id, p_dry_run: true });
    setBusy(false);
    if (e) return setError(friendlyError(e));
    setPending({ kind: 'undo', subId, hold, preview: data as unknown as ChangeResult });
  }

  // A cancel is previewed for the chosen date every time the date changes.
  async function previewCancel(subId: string, from: string) {
    start();
    setPending({ kind: 'cancel', subId, from, preview: null });
    setBusy(true);
    const { data, error: e } = await supabase.rpc('request_schedule_change', {
      p_subscription: subId, p_type: 'cancel', p_from: from, p_dry_run: true,
    });
    setBusy(false);
    if (e) return setError(friendlyError(e));
    setPending((p) => (p?.kind === 'cancel' && p.subId === subId && p.from === from ? { ...p, preview: data as unknown as ChangeResult } : p));
  }

  async function confirm() {
    if (!pending) return;
    setError('');
    setBusy(true);
    if (pending.kind === 'undo') {
      const { error: e } = await supabase.rpc('revoke_schedule_change', { p_change: pending.hold.change_id });
      setBusy(false);
      if (e) return setError(friendlyError(e));
      return finish(`${holdLabel(pending.hold)} · ${t('holds.undone')}`);
    }
    if (pending.kind === 'cancel') {
      const { error: e } = await supabase.rpc('request_schedule_change', {
        p_subscription: pending.subId, p_type: 'cancel', p_from: pending.from,
      });
      setBusy(false);
      if (e) return setError(friendlyError(e));
      return finish(t('subs.cancelled'));
    }
    const { data, error: e } = await supabase.rpc('reactivate_subscription', { p_subscription: pending.subId, p_from: pending.from });
    setBusy(false);
    if (e) return setError(friendlyError(e));
    const res = data as unknown as ReactivateResult;
    // On an empty prepaid balance the subscription comes back waiting for a payment (D-122).
    if (reactivatedWithoutBalance(res.status)) return finish(t('subs.reactivatedLow', { status: t(`subs.status.${res.status}`) }), true);
    finish(t('subs.reactivated', { date: formatServiceDate(res.from_date) }));
  }

  if (!subs) {
    return error ? <Card><Label>{t('subs.title')}</Label><ErrorText>{error}</ErrorText></Card> : null;
  }

  return (
    <Card>
      <Label>{t('subs.title')}</Label>
      {subs.length === 0 && <Muted>{t('subs.none')}</Muted>}
      {subs.map((s) => {
        const can = subscriptionActions(s.status);
        const mine = can.holds ? holds[s.id] ?? [] : [];
        const open = pending?.subId === s.id ? pending : null;
        const cancelPreview = open?.kind === 'cancel' ? open.preview : null;
        const counts = cancelPreview ? previewCounts(cancelPreview.affected) : null;
        return (
          <View key={s.id} style={kit.item} testID={`sub-${s.id}`}>
            <View style={kit.row}>
              <Text style={kit.itemTitle}>{s.plan?.name ?? '—'}{s.qty > 1 ? ` ${t('subs.qty', { n: s.qty })}` : ''}</Text>
              <Badge label={t(`subs.status.${s.status}`)} tone={STATUS_TONE[s.status] ?? 'gray'} />
            </View>
            <Text style={kit.small}>
              {s.end_date
                ? t('subs.fromTo', { from: formatServiceDate(s.start_date), to: formatServiceDate(s.end_date) })
                : t('subs.from', { date: formatServiceDate(s.start_date) })}
            </Text>

            {mine.length > 0 && (
              <>
                <Muted>{t('holds.title')}</Muted>
                <View style={kit.chips}>
                  {mine.map((h) => (
                    <Chip key={h.change_id} label={`${holdLabel(h)}  ↶ ${t('holds.undo')}`}
                      selected={open?.kind === 'undo' && open.hold.change_id === h.change_id}
                      onPress={() => void previewUndo(s.id, h)} />
                  ))}
                </View>
              </>
            )}

            {!open && (can.cancel || can.reactivate) && (
              <View style={kit.chips}>
                {can.reactivate && (
                  <Chip label={t('subs.reactivate')} selected={false}
                    onPress={() => { start(); setPending({ kind: 'reactivate', subId: s.id, from: today }); }} />
                )}
                {can.cancel && (
                  <Chip label={t('subs.cancel')} selected={false} onPress={() => void previewCancel(s.id, cancelFromDefault(today, noticeDays))} />
                )}
              </View>
            )}

            {open?.kind === 'undo' && (
              <ConfirmBox title={t('holds.undoTitle', { label: holdLabel(open.hold) })}>
                <Muted>
                  {open.preview.affected.length
                    ? t('holds.back', { meals: mealList(open.preview.affected) })
                    : t('holds.noneBack')}
                </Muted>
                <Text style={kit.small}>{t('holds.frozen')}</Text>
                <Button title={t('actions.confirm')} onPress={confirm} busy={busy} />
                <Button title={t('actions.back')} onPress={() => setPending(null)} variant="secondary" />
              </ConfirmBox>
            )}

            {open?.kind === 'cancel' && (
              <ConfirmBox title={`${t('subs.cancel')} · ${s.plan?.name ?? ''}`}>
                <DateStepper label={t('subs.cancelFrom')} value={open.from} min={today} max={addDays(today, 90)}
                  onChange={(d) => void previewCancel(s.id, d)} />
                <Muted>
                  {open.from <= (s.start_date > today ? s.start_date : today)
                    ? t('subs.cancelNow')
                    : t('subs.cancelLast', { date: formatServiceDate(addDays(open.from, -1)) })}
                </Muted>
                {cancelPreview && counts && (
                  <Muted>{counts.total ? t('subs.cancelAffects', { n: counts.total, meals: mealList(cancelPreview.affected) }) : t('actions.noneAffected')}</Muted>
                )}
                <Text style={kit.small}>{t('subs.cancelRefund')}</Text>
                <Button title={t('subs.cancelConfirm')} onPress={confirm} busy={busy} disabled={!open.preview} />
                <Button title={t('actions.back')} onPress={() => setPending(null)} variant="secondary" />
              </ConfirmBox>
            )}

            {open?.kind === 'reactivate' && (
              <ConfirmBox title={`${t('subs.reactivate')} · ${s.plan?.name ?? ''}`}>
                <DateStepper label={t('subs.reactivateFrom')} value={open.from} min={today} max={addDays(today, 90)}
                  onChange={(d) => setPending({ ...open, from: d })} />
                <Text style={kit.small}>{t('subs.reactivateHint')}</Text>
                <Button title={t('subs.reactivateConfirm')} onPress={confirm} busy={busy} />
                <Button title={t('actions.back')} onPress={() => setPending(null)} variant="secondary" />
              </ConfirmBox>
            )}
          </View>
        );
      })}
      {saved ? <Text style={saved.warn ? kit.warn : kit.saved}>{saved.warn ? '⚠ ' : '✓ '}{saved.text}</Text> : null}
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}
