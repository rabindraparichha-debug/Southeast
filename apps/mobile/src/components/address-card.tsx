import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { istDate } from '@tiffin/core';
import type { ChangeResult } from '@tiffin/db';
import { friendlyError } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { mealList, type Affected } from '@/lib/vendor-changes';
import { t } from '@/i18n';
import { Button, Card, Chip, ErrorText, Input, Label, Muted } from './ui';
import { Badge, ConfirmBox, kit } from './change-kit';

type Address = {
  id: string; label: string | null; line1: string | null; area: string | null; landmark: string | null;
  delivery_notes: string | null; lat: number | null; lng: number | null; is_default: boolean;
};
const blank = { label: '', line1: '', area: '', landmark: '', delivery_notes: '' };
type Form = typeof blank;

// "Make default": choose first (move the meals too, or only mark it); moving is previewed per
// subscription like any address change, then set_default_address applies it (D-124).
type DefaultFlow = { address: Address; step: 'choose' } | { address: Address; step: 'preview'; affected: Affected[] | null };

const title = (a: Address) => a.label || [a.line1, a.area].filter(Boolean).join(', ') || t('customer.address');

/**
 * The customer's addresses. Owner: add, edit and "make default" (optionally moving every live
 * subscription there from today, previewed first). Staff see the list only.
 * `version` changes whenever the screen reloads.
 */
export function AddressCard({ customerId, kitchenId, isOwner, version, onChanged }: {
  customerId: string; kitchenId: string; isOwner: boolean; version?: unknown; onChanged?: () => void;
}) {
  const [list, setList] = useState<Address[] | null>(null);
  const [editing, setEditing] = useState<Address | 'new' | null>(null);
  const [f, setF] = useState<Form>(blank);
  const [flow, setFlow] = useState<DefaultFlow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    void supabase
      .from('addresses')
      .select('id, label, line1, area, landmark, delivery_notes, lat, lng, is_default')
      .eq('customer_id', customerId)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: false })
      .then(({ data, error: e }) => {
        if (!alive) return;
        if (e) return setError(friendlyError(e));
        setList((data ?? []) as Address[]);
      });
    return () => {
      alive = false;
    };
  }, [customerId, version, reload]);

  const field = (k: keyof Form) => (v: string) => setF((x) => ({ ...x, [k]: v }));

  function reset() {
    setError('');
    setSaved('');
  }

  function done(text: string) {
    setSaved(text);
    setEditing(null);
    setFlow(null);
    setReload((n) => n + 1);
    onChanged?.();
  }

  function open(a: Address | 'new') {
    reset();
    setFlow(null);
    setEditing(a);
    setF(a === 'new' ? blank : {
      label: a.label ?? '', line1: a.line1 ?? '', area: a.area ?? '', landmark: a.landmark ?? '', delivery_notes: a.delivery_notes ?? '',
    });
  }

  async function save() {
    reset();
    if (![f.line1, f.area, f.landmark].some((v) => v.trim())) return setError(t('address.required'));
    const values = {
      label: f.label.trim() || null, line1: f.line1.trim() || null, area: f.area.trim() || null,
      landmark: f.landmark.trim() || null, delivery_notes: f.delivery_notes.trim() || null,
    };
    setBusy(true);
    // The first address becomes the default; the database then gives it to subscriptions without one.
    const { error: e } = editing === 'new' || !editing
      ? await supabase.from('addresses').insert({ ...values, kitchen_id: kitchenId, customer_id: customerId, is_default: (list?.length ?? 0) === 0 })
      : await supabase.from('addresses').update(values).eq('id', editing.id);
    setBusy(false);
    if (e) return setError(friendlyError(e));
    done(t('address.saved'));
  }

  async function previewMove(a: Address) {
    reset();
    setFlow({ address: a, step: 'preview', affected: null });
    setBusy(true);
    const today = istDate();
    const { data: subs, error: e } = await supabase.from('subscriptions').select('id').eq('customer_id', customerId).neq('status', 'cancelled');
    if (e) {
      setBusy(false);
      return setError(friendlyError(e));
    }
    const results = await Promise.all((subs ?? []).map((s) => supabase.rpc('request_schedule_change', {
      p_subscription: s.id, p_type: 'address', p_from: today, p_address: a.id, p_dry_run: true,
    })));
    setBusy(false);
    const failed = results.find((r) => r.error)?.error;
    if (failed) return setError(friendlyError(failed));
    const affected = results.flatMap((r) => (r.data as unknown as ChangeResult | null)?.affected ?? []);
    setFlow((x) => (x?.address.id === a.id && x.step === 'preview' ? { ...x, affected } : x));
  }

  async function makeDefault(a: Address, move: boolean) {
    reset();
    setBusy(true);
    const { data, error: e } = await supabase.rpc('set_default_address', { p_address: a.id, p_apply_to_subscriptions: move });
    setBusy(false);
    if (e) return setError(friendlyError(e));
    const n = (data as { subscriptions_moved?: number } | null)?.subscriptions_moved ?? 0;
    done(move ? t('address.moved', { n }) : t('address.defaultSet'));
  }

  if (!list) return error ? <Card><Label>{t('address.title')}</Label><ErrorText>{error}</ErrorText></Card> : null;

  return (
    <Card>
      <View style={kit.row}>
        <Label>{t('address.title')}</Label>
        {isOwner && !editing && (
          <Pressable accessibilityRole="button" onPress={() => open('new')} testID="address-add">
            <Text style={kit.link}>+ {t('address.add')}</Text>
          </Pressable>
        )}
      </View>

      {!editing && list.length === 0 && <Muted>{t('address.none')}</Muted>}
      {!editing && list.map((a) => (
        <View key={a.id} style={kit.item}>
          <View style={kit.row}>
            <Text style={kit.itemTitle}>{title(a)}</Text>
            {a.is_default && <Badge label={t('address.default')} tone="green" />}
          </View>
          <Muted>{[a.line1, a.landmark, a.area].filter(Boolean).join(', ') || '—'}</Muted>
          {a.delivery_notes ? <Text style={kit.small}>{t('rider.notes')}: {a.delivery_notes}</Text> : null}
          {a.lat == null || a.lng == null ? <Text style={kit.small}>{t('address.noPin')}</Text> : null}

          {isOwner && flow?.address.id !== a.id && (
            <View style={kit.chips}>
              {!a.is_default && <Chip label={t('address.makeDefault')} selected={false} onPress={() => { reset(); setFlow({ address: a, step: 'choose' }); }} />}
              <Chip label={t('address.edit')} selected={false} onPress={() => open(a)} />
            </View>
          )}

          {flow?.address.id === a.id && flow.step === 'choose' && (
            <ConfirmBox title={t('address.defaultQuestion')}>
              <Muted>{t('address.defaultHint')}</Muted>
              <Button title={t('address.moveMeals')} onPress={() => void previewMove(a)} busy={busy} />
              <Button title={t('address.onlyDefault')} onPress={() => void makeDefault(a, false)} variant="secondary" disabled={busy} />
              <Button title={t('actions.back')} onPress={() => setFlow(null)} variant="secondary" />
            </ConfirmBox>
          )}

          {flow?.address.id === a.id && flow.step === 'preview' && (
            <ConfirmBox title={t('address.moveMeals')}>
              {!flow.affected ? (
                <Muted>…</Muted>
              ) : (
                <Muted>{flow.affected.length ? t('address.movePreview', { meals: mealList(flow.affected) }) : t('address.moveNone')}</Muted>
              )}
              <Button title={t('actions.confirm')} onPress={() => void makeDefault(a, true)} busy={busy} disabled={!flow.affected} />
              <Button title={t('actions.back')} onPress={() => setFlow(null)} variant="secondary" />
            </ConfirmBox>
          )}
        </View>
      ))}

      {editing && (
        <View style={{ gap: 8 }}>
          <Label>{t('address.label')}</Label>
          <Input value={f.label} onChangeText={field('label')} placeholder="Home / Office" testID="address-label" />
          <Label>{t('customer.flat')}</Label>
          <Input value={f.line1} onChangeText={field('line1')} testID="address-line1" />
          <Label>{t('customer.area')}</Label>
          <Input value={f.area} onChangeText={field('area')} testID="address-area" />
          <Label>{t('customer.landmark')}</Label>
          <Input value={f.landmark} onChangeText={field('landmark')} testID="address-landmark" />
          <Label>{t('address.notes')}</Label>
          <Input value={f.delivery_notes} onChangeText={field('delivery_notes')} testID="address-notes" />
          <Button title={t('address.save')} onPress={save} busy={busy} />
          <Button title={t('actions.back')} onPress={() => setEditing(null)} variant="secondary" />
        </View>
      )}

      {saved ? <Text style={kit.saved}>✓ {saved}</Text> : null}
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}
