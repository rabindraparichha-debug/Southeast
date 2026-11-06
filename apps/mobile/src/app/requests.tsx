import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { Redirect, router, useFocusEffect } from 'expo-router';
import { SLOT_LABEL, formatIstShort, formatServiceDate } from '@tiffin/core';
import type { ChangeResult } from '@tiffin/db';
import { supabase } from '@/lib/supabase';
import { useKitchen } from '@/lib/session';
import { friendlyError } from '@/lib/errors';
import { isLead } from '@/lib/roles';
import { ALL_STATUSES, isOfflineError, requestDates, type ChangeRequestRow } from '@/lib/money';
import { Button, Card, Chip, ErrorText, Input, Label, Muted } from '@/components/ui';
import { colors, radius, space } from '@/components/theme';
import { t } from '@/i18n';

type Choice = { id: string; label: string };

// Change requests riders recorded at the door (D-117). Owners and managers check the effect,
// then approve (applied through the normal change path, late meals charged unless waived) or reject.
export default function Requests() {
  const kitchen = useKitchen();
  const [rows, setRows] = useState<ChangeRequestRow[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error: e } = await supabase.rpc('change_requests_list', {
      p_kitchen: kitchen.kitchenId, p_status: showAll ? ALL_STATUSES : 'pending', p_limit: 100,
    });
    setLoading(false);
    if (e) return setError(isOfflineError(e) ? t('money.offline') : friendlyError(e));
    setError('');
    setRows((data ?? []) as unknown as ChangeRequestRow[]);
  }, [kitchen.kitchenId, showAll]);

  useFocusEffect(useCallback(() => void load(), [load]));

  if (!isLead(kitchen.role)) return <Redirect href="/" />;
  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}>
      <View style={styles.chips}>
        <Chip label={t('requests.waiting')} selected={!showAll} onPress={() => setShowAll(false)} />
        <Chip label={t('requests.all')} selected={showAll} onPress={() => setShowAll(true)} />
      </View>
      <ErrorText>{error}</ErrorText>
      {!loading && rows.length === 0 && !error && <Card><Muted>{t('requests.none')}</Muted></Card>}
      {rows.map((r) => <RequestCard key={r.id} r={r} kitchenId={kitchen.kitchenId} onDone={load} />)}
    </ScrollView>
  );
}

function RequestCard({ r, kitchenId, onDone }: { r: ChangeRequestRow; kitchenId: string; onDone: () => void }) {
  const pending = r.status === 'pending';
  const [open, setOpen] = useState(false);
  const [plans, setPlans] = useState<Choice[]>([]);
  const [addresses, setAddresses] = useState<Choice[]>([]);
  const [sub, setSub] = useState<string | null>(r.subscription_id);
  const [address, setAddress] = useState<string | null>(null);
  const [newAddress, setNewAddress] = useState({ line1: r.note ?? '', landmark: '', area: '' });
  const [adding, setAdding] = useState(false);
  const [waive, setWaive] = useState(false);
  const [preview, setPreview] = useState<ChangeResult | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);

  const loadChoices = useCallback(async () => {
    const [s, a] = await Promise.all([
      r.subscription_id ? Promise.resolve({ data: [] }) :
        supabase.from('subscriptions').select('id, status, plan:plans(name)').eq('customer_id', r.customer_id).neq('status', 'cancelled'),
      r.type === 'address' ? supabase.from('addresses').select('id, line1, landmark, area, is_default').eq('customer_id', r.customer_id).order('created_at', { ascending: false })
        : Promise.resolve({ data: [] }),
    ]);
    const subs = (s.data ?? []) as { id: string; status: string; plan: { name: string } | null }[];
    setPlans(subs.map((x) => ({ id: x.id, label: `${x.plan?.name ?? '—'}${x.status === 'active' ? '' : ` (${x.status})`}` })));
    if (!r.subscription_id && subs.length === 1) setSub(subs[0]!.id);
    const list = (a.data ?? []) as { id: string; line1: string | null; landmark: string | null; area: string | null; is_default: boolean }[];
    setAddresses(list.map((x) => ({
      id: x.id,
      label: [x.line1, x.landmark, x.area].filter(Boolean).join(', ') + (x.is_default ? ` · ${t('requests.currentAddress')}` : ''),
    })));
  }, [r.customer_id, r.subscription_id, r.type]);

  async function expand() {
    setOpen(true);
    // Nothing to choose (one plan, not an address): show the effect straight away.
    if (r.subscription_id && r.type !== 'address') return approve(true);
    await loadChoices();
  }

  async function approve(dryRun: boolean, waiveLate = waive) {
    setBusy(true);
    setError('');
    const { data, error: e } = await supabase.rpc('approve_change_request', {
      p_request: r.id,
      p_waive_late: waiveLate,
      p_dry_run: dryRun,
      p_subscription: r.subscription_id ? undefined : sub ?? undefined,
      p_address: r.type === 'address' ? address ?? undefined : undefined,
    });
    setBusy(false);
    if (e) return setError(isOfflineError(e) ? t('money.offline') : friendlyError(e));
    if (dryRun) return setPreview(data as unknown as ChangeResult);
    setDone(t('requests.approved'));
    onDone();
  }

  async function reject() {
    setBusy(true);
    setError('');
    const { error: e } = await supabase.rpc('reject_change_request', { p_request: r.id, p_reason: reason.trim() || undefined });
    setBusy(false);
    if (e) return setError(friendlyError(e));
    setDone(t('requests.rejected'));
    onDone();
  }

  async function saveAddress() {
    if (!newAddress.line1.trim()) return setError(t('errors.note_required'));
    setBusy(true);
    setError('');
    const { data, error: e } = await supabase.from('addresses').insert({
      kitchen_id: kitchenId, customer_id: r.customer_id, line1: newAddress.line1.trim(),
      landmark: newAddress.landmark.trim() || null, area: newAddress.area.trim() || null, is_default: false,
    }).select('id').single();
    setBusy(false);
    if (e || !data) return setError(friendlyError(e));
    setAdding(false);
    await loadChoices();
    setAddress(data.id);
    setPreview(null);
  }

  const charged = preview?.affected.filter((a) => a.charged) ?? [];
  const late = preview?.affected.filter((a) => a.late) ?? [];
  const ready = (r.subscription_id || sub) && (r.type !== 'address' || address);

  return (
    <Card>
      <View style={styles.head}>
        <Pressable style={{ flex: 1 }} onPress={() => router.push({ pathname: '/customer/[id]', params: { id: r.customer_id } })}>
          <Text style={styles.name}>{r.customer_name}</Text>
        </Pressable>
        <Text style={[styles.status, r.status === 'pending' && { color: colors.jain }, r.status === 'approved' && { color: colors.veg }]}>
          {t(`requests.status.${r.status}`)}
        </Text>
      </View>
      <Text style={styles.what}>{t(`requests.type.${r.type}`)} · {requestDates(r)}</Text>
      {r.note ? <Text style={styles.note}>“{r.note}”</Text> : null}
      <Muted>
        {t('requests.fromRider', { name: r.requested_by_name || t('role.rider') })} · {formatIstShort(r.requested_at)}{r.plan_name ? ` · ${r.plan_name}` : ''}
      </Muted>
      {!pending && r.decision_note ? <Muted>{r.decision_note}</Muted> : null}

      {pending && !done && !open && <Button title={t('requests.check')} onPress={expand} />}

      {pending && !done && open && (
        <View style={styles.body}>
          {!r.subscription_id && (
            <>
              <Label>{t('requests.whichPlan')}</Label>
              {plans.length === 0 && <Muted>{t('requests.noPlan')}</Muted>}
              <View style={styles.chips}>
                {plans.map((p) => <Chip key={p.id} label={p.label} selected={sub === p.id} onPress={() => { setSub(p.id); setPreview(null); }} />)}
              </View>
            </>
          )}
          {r.type === 'address' && (
            <>
              <Label>{t('requests.deliverTo')}</Label>
              {addresses.map((a) => (
                <Chip key={a.id} label={a.label} selected={address === a.id} onPress={() => { setAddress(a.id); setPreview(null); }} />
              ))}
              {!adding && <Chip label={`+ ${t('requests.addAddress')}`} selected={false} onPress={() => setAdding(true)} />}
              {adding && (
                <View style={styles.confirm}>
                  <Label>{t('requests.line1')}</Label>
                  <Input value={newAddress.line1} onChangeText={(v) => setNewAddress({ ...newAddress, line1: v })} multiline />
                  <Label>{t('requests.landmark')}</Label>
                  <Input value={newAddress.landmark} onChangeText={(v) => setNewAddress({ ...newAddress, landmark: v })} />
                  <Label>{t('requests.area')}</Label>
                  <Input value={newAddress.area} onChangeText={(v) => setNewAddress({ ...newAddress, area: v })} />
                  <Button title={t('requests.saveAddress')} onPress={saveAddress} busy={busy} />
                  <Button title={t('actions.back')} onPress={() => setAdding(false)} variant="secondary" />
                </View>
              )}
            </>
          )}

          {preview && (
            <View style={styles.confirm}>
              <Muted>
                {preview.affected.length
                  ? t('actions.affects', { meals: preview.affected.slice(0, 4).map((a) => `${formatServiceDate(a.date)} ${SLOT_LABEL[a.slot]}`).join(', ') + (preview.affected.length > 4 ? '…' : '') })
                  : t('actions.noneAffected')}
              </Muted>
              {charged.length > 0 && <Text style={styles.warn}>{t('actions.charged', { n: charged.length })}</Text>}
              {late.length > 0 && (r.type === 'skip' || r.type === 'pause') && (
                <View style={styles.toggle}>
                  <Text style={styles.toggleText}>{t('requests.waive')}</Text>
                  <Switch value={waive} onValueChange={(v) => { setWaive(v); void approve(true, v); }} />
                </View>
              )}
            </View>
          )}

          <ErrorText>{error}</ErrorText>
          {!rejecting && (
            !preview
              ? <Button title={t('requests.check')} onPress={() => approve(true)} busy={busy} disabled={!ready} />
              : <Button title={t('requests.approve')} onPress={() => approve(false)} busy={busy} />
          )}
          {rejecting ? (
            <View style={styles.confirm}>
              <Label>{t('requests.rejectWhy')}</Label>
              <Input value={reason} onChangeText={setReason} placeholder={t('requests.rejectPlaceholder')} />
              <Button title={t('requests.reject')} onPress={reject} busy={busy} />
              <Button title={t('actions.back')} onPress={() => setRejecting(false)} variant="secondary" />
            </View>
          ) : (
            <Pressable onPress={() => setRejecting(true)}><Text style={styles.link}>{t('requests.reject')}</Text></Pressable>
          )}
        </View>
      )}
      {pending && !open && error ? <ErrorText>{error}</ErrorText> : null}
      {done ? <Text style={styles.done}>✓ {done}</Text> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  content: { padding: space(4), gap: space(3) },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  head: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  name: { fontSize: 17, fontWeight: '600', color: colors.ink },
  status: { fontSize: 13, fontWeight: '600', color: colors.muted },
  what: { fontSize: 15, fontWeight: '500', color: colors.ink },
  note: { fontSize: 14, color: colors.inkSoft, fontStyle: 'italic' },
  body: { gap: space(2), marginTop: space(1) },
  confirm: { gap: space(2), backgroundColor: colors.brandSoft, padding: space(3), borderRadius: radius },
  warn: { color: '#B45309', fontWeight: '600' },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: space(3) },
  toggleText: { flex: 1, color: colors.ink },
  link: { textAlign: 'center', paddingVertical: space(2), color: colors.danger, textDecorationLine: 'underline' },
  done: { color: colors.veg, fontWeight: '600' },
});
