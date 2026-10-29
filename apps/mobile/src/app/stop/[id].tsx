import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { rupeesToPaise } from '@tiffin/core';
import { Button, Card, Chip, ErrorText, Input, Label, Muted } from '@/components/ui';
import { colors, space } from '@/components/theme';
import { friendlyError } from '@/lib/errors';
import { act, isNetworkError, keepPhoto, useRider, uuid } from '@/lib/rider-store';
import { supabase } from '@/lib/supabase';
import { t } from '@/i18n';

const REASONS = ['not_home', 'wrong_address', 'refused', 'unreachable', 'kitchen_late', 'food_issue', 'missing_meal', 'rider_issue', 'other'] as const;
const KITCHEN_FAULT = new Set(['kitchen_late', 'food_issue', 'missing_meal', 'rider_issue']);
type Reason = (typeof REASONS)[number];

/** Best-effort GPS fix: a recent known position, else a quick fresh one. Never blocks for long. */
async function gps(): Promise<{ lat: number; lng: number; accuracy: number | null } | null> {
  try {
    const perm = await Location.requestForegroundPermissionsAsync();
    if (!perm.granted) return null;
    const last = await Location.getLastKnownPositionAsync({ maxAge: 60000, requiredAccuracy: 200 });
    const pos = last ?? (await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise<null>((r) => setTimeout(() => r(null), 6000)),
    ]));
    return pos ? { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy ?? null } : null;
  } catch {
    return null;
  }
}

function Stepper({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <View style={styles.stepper}>
      <Text style={styles.stepLabel}>{label}</Text>
      <Pressable style={styles.stepBtn} onPress={() => onChange(Math.max(0, value - 1))}><Text style={styles.stepTxt}>−</Text></Pressable>
      <Text style={styles.stepValue}>{value}</Text>
      <Pressable style={styles.stepBtn} onPress={() => onChange(Math.min(20, value + 1))}><Text style={styles.stepTxt}>+</Text></Pressable>
    </View>
  );
}

export default function StopScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const rider = useRider();
  const run0 = rider.runs.find((r) => r.stops.some((s) => s.id === id));
  const found = run0 ? { run: run0, stop: run0.stops.find((s) => s.id === id)! } : null;

  const [otp, setOtp] = useState('');
  const [tiffinsOut, setTiffinsOut] = useState<number | null>(null);
  const [tiffinsBack, setTiffinsBack] = useState<number | null>(null);
  const [cash, setCash] = useState('');
  const [failing, setFailing] = useState(false);
  const [reason, setReason] = useState<Reason | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!found) {
    return <View style={styles.screen}><Muted>{t('errors.not_found')}</Muted></View>;
  }
  const { run, stop } = found;
  const out = tiffinsOut ?? stop.meal_count;
  const back = tiffinsBack ?? Math.min(stop.tiffins_with_customer, stop.meal_count);
  const canAct = stop.status === 'pending' && run.status !== 'done';

  const navigate = () => {
    const dest = stop.lat != null && stop.lng != null
      ? `${stop.lat},${stop.lng}`
      : encodeURIComponent([stop.line1, stop.landmark, stop.area, 'Bhubaneswar'].filter(Boolean).join(', '));
    void Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=two-wheeler`);
  };

  const call = async () => {
    setError('');
    const { data, error: e } = await supabase.rpc('rider_call_number', { p_stop: stop.id });
    if (e) return setError(isNetworkError(e) ? t('rider.callOffline') : friendlyError(e));
    void Linking.openURL(`tel:${data}`);
  };

  const cashPaise = (() => {
    const n = Number(cash.replace(/[^\d.]/g, ''));
    return cash.trim() && Number.isFinite(n) && n > 0 ? rupeesToPaise(n) : 0;
  })();

  const deliver = async (proof: 'otp' | 'photo' | 'none') => {
    setError('');
    if (proof === 'otp' && !/^\d{4}$/.test(otp.trim())) return setError(t('rider.otpWrong'));
    let photoUri: string | undefined;
    let photoPath: string | undefined;
    const op = uuid();
    if (proof === 'photo') {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) return setError(t('rider.cameraDenied'));
      const shot = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.4, allowsEditing: false, exif: false });
      if (shot.canceled || !shot.assets[0]) return;
      photoUri = await keepPhoto(shot.assets[0].uri, op);
      photoPath = `${run.kitchen_id}/${run.service_date}/${stop.id}-${op.slice(0, 8)}.jpg`;
    }
    setBusy(true);
    const pos = await gps();
    const res = await act({
      op, kind: 'complete', runId: run.id, stopId: stop.id, photoUri, photoPath,
      args: {
        p_proof: proof, p_otp: proof === 'otp' ? otp.trim() : null, p_lat: pos?.lat ?? null, p_lng: pos?.lng ?? null,
        p_accuracy: pos?.accuracy ?? null, p_tiffins_out: out, p_tiffins_returned: back, p_cash_paise: cashPaise,
      },
    });
    setBusy(false);
    if (res.otpWrong) return setError(t('rider.otpWrong'));
    if (res.error) return setError(friendlyError({ message: res.error }));
    router.back();
  };

  const fail = async () => {
    setError('');
    if (!reason) return setError(t('errors.reason_required'));
    if (reason === 'other' && !note.trim()) return setError(t('errors.note_required'));
    setBusy(true);
    const pos = await gps();
    const res = await act({
      kind: 'fail', runId: run.id, stopId: stop.id,
      args: { p_reason: reason, p_note: note.trim() || null, p_lat: pos?.lat ?? null, p_lng: pos?.lng ?? null, p_tiffins_returned: back },
    });
    setBusy(false);
    if (res.error) return setError(friendlyError({ message: res.error }));
    router.back();
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ gap: space(3), paddingBottom: space(10) }} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: `${stop.seq}. ${stop.name}` }} />
      <Card>
        <Text style={styles.addr}>{[stop.line1, stop.landmark, stop.area].filter(Boolean).join(', ')}</Text>
        {stop.delivery_notes ? <Text style={styles.note}>{t('rider.notes')}: {stop.delivery_notes}</Text> : null}
        <Muted>{t('rider.meals', { n: stop.meal_count })}{stop.tiffins_with_customer > 0 ? ` · ${t('rider.tiffinsHeld', { n: stop.tiffins_with_customer })}` : ''}</Muted>
        <Muted>{stop.phone_masked}</Muted>
        <View style={styles.row}>
          <View style={{ flex: 1 }}><Button title={t('rider.navigate')} onPress={navigate} /></View>
          <View style={{ flex: 1 }}><Button title={t('rider.call')} variant="secondary" onPress={call} disabled={!canAct || run.status !== 'out'} /></View>
        </View>
      </Card>

      {stop.status !== 'pending' && (
        <Card>
          <Text style={[styles.status, { color: stop.status === 'delivered' ? colors.veg : colors.danger }]}>
            {t(`rider.status.${stop.status}`)}{stop.failed_reason ? ` · ${t(`rider.reason.${stop.failed_reason}`)}` : ''}
          </Text>
          {stop.queued && <Muted>{t('rider.queued')}</Muted>}
        </Card>
      )}

      {canAct && !failing && (
        <Card>
          <Stepper label={t('rider.tiffinsOut')} value={out} onChange={setTiffinsOut} />
          <Stepper label={t('rider.tiffinsReturned')} value={back} onChange={setTiffinsBack} />
          <Label>{t('rider.cash')}</Label>
          <Input value={cash} onChangeText={setCash} keyboardType="numeric" placeholder="0" />
          <Label>{t('rider.otp')}</Label>
          <Muted>{stop.otp_sent ? t('rider.otpHint') : t('rider.otpNotSent')}</Muted>
          <Input value={otp} onChangeText={setOtp} keyboardType="number-pad" maxLength={4} placeholder="0000" />
          <ErrorText>{error}</ErrorText>
          <Button title={t('rider.confirmOtp')} onPress={() => deliver('otp')} busy={busy} disabled={otp.trim().length !== 4} />
          <Button title={t('rider.photo')} variant="secondary" onPress={() => deliver('photo')} disabled={busy} />
          <Pressable onPress={() => deliver('none')} disabled={busy}><Text style={styles.link}>{t('rider.noProof')}</Text></Pressable>
          <Pressable onPress={() => setFailing(true)}><Text style={[styles.link, { color: colors.danger }]}>{t('rider.fail')}</Text></Pressable>
        </Card>
      )}

      {canAct && failing && (
        <Card>
          <Label>{t('rider.failReason')}</Label>
          <View style={styles.chips}>
            {REASONS.map((r) => <Chip key={r} label={t(`rider.reason.${r}`)} selected={reason === r} onPress={() => setReason(r)} />)}
          </View>
          {reason && KITCHEN_FAULT.has(reason) && <Muted>{t('rider.kitchenFault')}</Muted>}
          <Label>{t('rider.failNote')}</Label>
          <Input value={note} onChangeText={setNote} placeholder="" />
          <Stepper label={t('rider.tiffinsReturned')} value={back} onChange={setTiffinsBack} />
          <ErrorText>{error}</ErrorText>
          <Button title={t('rider.failSave')} onPress={fail} busy={busy} />
          <Button title={t('actions.back')} variant="secondary" onPress={() => setFailing(false)} />
        </Card>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, padding: space(4) },
  addr: { fontSize: 16, color: colors.ink, fontWeight: '500' },
  note: { fontSize: 14, color: colors.jain },
  row: { flexDirection: 'row', gap: space(2) },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  status: { fontSize: 16, fontWeight: '600' },
  link: { textAlign: 'center', paddingVertical: space(2), color: colors.inkSoft, textDecorationLine: 'underline' },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: space(3) },
  stepLabel: { flex: 1, fontSize: 15, color: colors.inkSoft },
  stepBtn: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  stepTxt: { fontSize: 20, color: colors.ink },
  stepValue: { minWidth: 24, textAlign: 'center', fontSize: 18, fontWeight: '600', color: colors.ink },
});
