// Rider tab additions (audit item 25), kept out of the rider screen itself:
// - owners see today's runs that have no rider and can take them ("Always me" also sets the route);
// - whoever collected cash sees how much they hold, with a link to the handover screen.
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SLOT_LABEL, formatPaise } from '@tiffin/core';
import type { MealSlot } from '@tiffin/db';
import { Button, Card, ErrorText, Muted } from './ui';
import { colors, space } from './theme';
import { friendlyError } from '@/lib/errors';
import { refreshRider } from '@/lib/rider-store';
import { useAuth } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { t } from '@/i18n';

type Unassigned = { id: string; route_id: string; route_name: string; slot: MealSlot; stops: number; kitchen_name: string };

export function RiderExtras() {
  const { session, memberships } = useAuth();
  const isOwner = memberships.some((m) => m.role === 'owner');
  const [runs, setRuns] = useState<Unassigned[]>([]);
  const [cash, setCash] = useState<{ paise: number; n: number }>({ paise: 0, n: 0 });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const [u, c] = await Promise.all([
      isOwner ? supabase.rpc('unassigned_runs') : Promise.resolve({ data: [], error: null }),
      supabase.rpc('my_cash_handover'),
    ]);
    if (!u.error) setRuns((u.data ?? []) as unknown as Unassigned[]);
    const mine = (c.data ?? []) as unknown as { pending_paise: number; pending_count: number }[];
    setCash({ paise: mine.reduce((s, m) => s + m.pending_paise, 0), n: mine.reduce((s, m) => s + m.pending_count, 0) });
  }, [isOwner]);

  useFocusEffect(useCallback(() => void load(), [load]));

  const take = async (run: Unassigned, always: boolean) => {
    if (!session) return;
    setBusy(run.id);
    setError('');
    const r = await supabase.rpc('assign_run', { p_run: run.id, p_rider: session.user.id });
    const e = r.error ?? (always ? (await supabase.rpc('update_route', { p_route: run.route_id, p_rider: session.user.id })).error : null);
    setBusy(null);
    if (e) setError(friendlyError(e));
    await refreshRider();
    await load();
  };

  if (!runs.length && cash.n === 0 && !error) return null;
  return (
    <View style={{ gap: space(2) }}>
      {runs.length > 0 && (
        <Card>
          <Text style={styles.h}>{t('rider.unassigned')}</Text>
          {runs.map((r) => (
            <View key={r.id} style={styles.item}>
              <Text style={styles.line}>{t('rider.unassignedLine', { slot: SLOT_LABEL[r.slot], route: r.route_name, stops: r.stops })}</Text>
              {memberships.length > 1 && <Muted>{r.kitchen_name}</Muted>}
              <View style={styles.row}>
                <View style={{ flex: 1 }}><Button title={t('rider.take')} onPress={() => take(r, false)} busy={busy === r.id} /></View>
                <View style={{ flex: 1 }}><Button title={t('rider.takeAlways', { route: r.route_name })} variant="secondary" onPress={() => take(r, true)} disabled={busy === r.id} /></View>
              </View>
            </View>
          ))}
        </Card>
      )}
      {cash.n > 0 && (
        <Pressable onPress={() => router.push('/handover')}>
          <Card><Text style={styles.line}>{t('rider.myCash', { amount: formatPaise(cash.paise), n: cash.n })} ›</Text></Card>
        </Pressable>
      )}
      <ErrorText>{error}</ErrorText>
    </View>
  );
}

const styles = StyleSheet.create({
  h: { fontSize: 16, fontWeight: '600', color: colors.ink },
  item: { gap: space(1), paddingTop: space(2) },
  line: { fontSize: 15, color: colors.ink },
  row: { flexDirection: 'row', gap: space(2) },
});
