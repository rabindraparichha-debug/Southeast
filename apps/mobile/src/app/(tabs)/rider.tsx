import * as Location from 'expo-location';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { formatIstShort, SLOT_LABEL } from '@tiffin/core';
import { Button, Card, Chip, ErrorText, Muted, Screen } from '@/components/ui';
import { colors, radius, space } from '@/components/theme';
import { friendlyError } from '@/lib/errors';
import { act, clearRiderError, loadRider, refreshRider, useRider, type RiderRun, type RiderStop } from '@/lib/rider-store';
import { useAuth } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { t } from '@/i18n';

const STATUS_COLOR = { pending: colors.inkSoft, delivered: colors.veg, failed: colors.danger } as const;

export default function Rider() {
  const rider = useRider();
  const { memberships } = useAuth();
  const [runId, setRunId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await refreshRider();
    setRefreshing(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadRider().then(refresh);
      // Keep trying to sync while the screen is open.
      const timer = setInterval(() => void refreshRider(), 30000);
      return () => clearInterval(timer);
    }, [refresh]),
  );

  const run: RiderRun | undefined = useMemo(
    () => rider.runs.find((r) => r.id === runId) ?? rider.runs.find((r) => r.status !== 'done') ?? rider.runs[0],
    [rider.runs, runId],
  );

  // Live location for the kitchen's board while the run is out (online only, never queued).
  useEffect(() => {
    if (run?.status !== 'out') return;
    let alive = true;
    const ping = async () => {
      const perm = await Location.getForegroundPermissionsAsync();
      if (!perm.granted || !alive) return;
      const pos = await Location.getLastKnownPositionAsync({ maxAge: 120000 });
      if (pos && alive) await supabase.rpc('rider_ping', { p_run: run.id, p_lat: pos.coords.latitude, p_lng: pos.coords.longitude });
    };
    void ping();
    const timer = setInterval(() => void ping(), 60000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [run?.id, run?.status]);

  if (!rider.loaded) return <Screen><Muted>…</Muted></Screen>;

  // A rider shared by several kitchens gets runs from each: always say whose run it is then.
  const manyKitchens = new Set(rider.runs.map((r) => r.kitchen_id)).size > 1 || memberships.length > 1;

  const done = run ? run.stops.filter((s) => s.status !== 'pending').length : 0;
  const allDone = run ? done === run.stops.length : false;

  const start = async () => {
    if (!run) return;
    setBusy(true);
    await Location.requestForegroundPermissionsAsync().catch(() => null);
    await act({ kind: 'start', runId: run.id, args: {} });
    setBusy(false);
  };
  const finish = async () => {
    if (!run) return;
    setBusy(true);
    await act({ kind: 'finish', runId: run.id, args: {} });
    setBusy(false);
  };

  return (
    <Screen style={{ paddingBottom: 0 }}>
      {!rider.online && <Banner tone="warn" text={t('rider.offline', { n: rider.queue.length })} />}
      {rider.online && rider.queue.length > 0 && <Banner tone="info" text={t('rider.pending', { n: rider.queue.length })} />}
      {rider.lastError && (
        <Pressable onPress={clearRiderError}>
          <ErrorText>{t('rider.syncFailed', { error: friendlyError({ message: rider.lastError }) })}</ErrorText>
        </Pressable>
      )}

      {rider.runs.length > 1 && (
        <View style={styles.chips}>
          {rider.runs.map((r) => (
            <Chip key={r.id} selected={r.id === run?.id} onPress={() => setRunId(r.id)}
              label={`${manyKitchens ? `${r.kitchen_name} · ` : ''}${SLOT_LABEL[r.slot]} · ${r.route_name}`} />
          ))}
        </View>
      )}

      {!run ? (
        <Card>
          <Muted>{t('rider.none')}</Muted>
          <Button title="↻" variant="secondary" onPress={refresh} busy={refreshing} />
        </Card>
      ) : (
        <FlatList
          data={run.stops}
          keyExtractor={(s) => s.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
          contentContainerStyle={{ gap: space(2), paddingBottom: space(6) }}
          ListHeaderComponent={
            <Card style={{ marginBottom: space(1) }}>
              {manyKitchens && <Text style={styles.kitchen}>{run.kitchen_name}</Text>}
              <View style={styles.row}>
                <Text style={styles.runTitle}>{SLOT_LABEL[run.slot]} · {run.route_name}</Text>
                <Text style={styles.muted}>{run.planned_km ? t('rider.km', { km: run.planned_km }) : ''}</Text>
              </View>
              <Muted>{t('rider.progress', { done, total: run.stops.length })}</Muted>
              <View style={styles.bar}>
                <View style={[styles.barFill, { flex: done }]} />
                <View style={{ flex: Math.max(0, run.stops.length - done) }} />
              </View>
              {run.status === 'planned' && (
                <>
                  <Button title={t('rider.start')} onPress={start} busy={busy} />
                  <Muted>{t('rider.startHint')}</Muted>
                </>
              )}
              {run.status === 'out' && allDone && <Button title={t('rider.finish')} onPress={finish} busy={busy} />}
              {run.status === 'done' && <Muted>{t('rider.done')}</Muted>}
              {rider.fetchedAt && <Text style={styles.small}>{t('rider.lastUpdated', { time: formatIstShort(rider.fetchedAt) })}</Text>}
            </Card>
          }
          renderItem={({ item }) => <StopRow stop={item} />}
        />
      )}
    </Screen>
  );
}

function StopRow({ stop }: { stop: RiderStop }) {
  const diets = Object.entries(stop.diets ?? {}).map(([d, n]) => `${n} ${d === 'nonveg' ? 'non-veg' : d}`).join(', ');
  return (
    <Pressable onPress={() => router.push({ pathname: '/stop/[id]', params: { id: stop.id } })}
      style={({ pressed }) => [styles.stop, stop.status !== 'pending' && { opacity: 0.6 }, pressed && { opacity: 0.8 }]}>
      <View style={styles.seq}><Text style={styles.seqText}>{stop.seq}</Text></View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.name}>{stop.office ? `🏢 ${stop.name}` : stop.name}</Text>
        {stop.office && <Text style={styles.office}>{t('rider.officeMeals', { n: stop.meal_count })}</Text>}
        <Text style={styles.addr}>{[stop.line1, stop.landmark, stop.area].filter(Boolean).join(', ')}</Text>
        <Text style={styles.small}>{stop.office ? diets : `${t('rider.meals', { n: stop.meal_count })}${diets ? ` · ${diets}` : ''}`}
          {stop.tiffins_with_customer > 0 ? ` · ${t('rider.tiffinsHeld', { n: stop.tiffins_with_customer })}` : ''}</Text>
        {stop.delivery_notes ? <Text style={styles.note}>{t('rider.notes')}: {stop.delivery_notes}</Text> : null}
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={[styles.status, { color: STATUS_COLOR[stop.status] }]}>{t(`rider.status.${stop.status}`)}</Text>
        {stop.queued && <Text style={styles.small}>⏳</Text>}
      </View>
    </Pressable>
  );
}

function Banner({ text, tone }: { text: string; tone: 'warn' | 'info' }) {
  return (
    <View style={[styles.banner, tone === 'warn' ? { backgroundColor: '#FEF3C7' } : { backgroundColor: colors.brandSoft }]}>
      <Text style={{ color: colors.ink }}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  kitchen: { fontSize: 13, fontWeight: '700', color: colors.brand, textTransform: 'uppercase' },
  office: { fontSize: 14, fontWeight: '700', color: colors.brand },
  runTitle: { fontSize: 18, fontWeight: '600', color: colors.ink },
  muted: { color: colors.muted },
  small: { fontSize: 12, color: colors.muted },
  bar: { flexDirection: 'row', height: 8, borderRadius: 4, backgroundColor: colors.line, overflow: 'hidden' },
  barFill: { backgroundColor: colors.veg },
  stop: { flexDirection: 'row', gap: space(3), backgroundColor: colors.card, borderRadius: radius, borderWidth: 1, borderColor: colors.line, padding: space(3), alignItems: 'flex-start' },
  seq: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.brandSoft, alignItems: 'center', justifyContent: 'center' },
  seqText: { fontWeight: '700', color: colors.brand },
  name: { fontSize: 16, fontWeight: '600', color: colors.ink },
  addr: { fontSize: 14, color: colors.inkSoft },
  note: { fontSize: 13, color: colors.jain },
  status: { fontSize: 13, fontWeight: '600' },
  banner: { borderRadius: 10, padding: space(3) },
});
