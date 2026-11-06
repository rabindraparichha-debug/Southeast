import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Redirect, router, useFocusEffect } from 'expo-router';
import { addDays, formatIstShort, formatServiceDate, istDate } from '@tiffin/core';
import type { Database, MealSlot, SlotSummary } from '@tiffin/db';
import { supabase } from '@/lib/supabase';
import { useKitchen } from '@/lib/session';
import { Card, Muted, Title } from '@/components/ui';
import { SlotCard } from '@/components/slot-card';
import { DispatchPhotoCard } from '@/components/dispatch-photo';
import { AtRiskCard, SpecialsCard } from '@/components/insights';
import { LeadCards } from '@/components/lead-cards';
import { MoneyOverview } from '@/components/money-overview';
import { isLead } from '@/lib/roles';
import { ClosuresCard } from '@/components/closures-card';
import { StaleBanner } from '@/components/offline-banner';
import { cachedFetch, useCacheScope, type Stale } from '@/lib/cached-fetch';
import { SyncRejectsCard } from '@/components/sync-rejects';
import { OwnerDesk } from '@/components/owner-desk';
import { colors, space } from '@/components/theme';
import { locale, t } from '@/i18n';

type Change = Database['public']['Functions']['change_feed']['Returns'][number];

export default function Today() {
  const kitchen = useKitchen();
  const [slots, setSlots] = useState<SlotSummary[]>([]);
  const [changes, setChanges] = useState<Change[]>([]);
  const [todo, setTodo] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [version, setVersion] = useState(0); // reloads the cards below on focus and pull-to-refresh
  const scope = useCacheScope();
  const [stale, setStale] = useState<Stale | null>(null); // showing the copy saved on this phone

  const load = useCallback(async () => {
    if (kitchen.role === 'rider') return;
    setVersion((v) => v + 1);
    if (kitchen.role === 'accountant') return; // money home: no counts or kitchen orders
    const today = istDate();
    const wanted: [string, MealSlot][] = [[today, 'lunch'], [today, 'dinner'], [addDays(today, 1), 'lunch'], [addDays(today, 1), 'dinner']];
    // Offline (or the server fails): the last copy saved on this phone, with a banner saying so.
    const res = await cachedFetch({
      scope, screen: 'today',
      fetch: async () => {
        const [results, feed] = await Promise.all([
          Promise.all(wanted.map(([d, s]) => supabase.rpc('slot_summary', { p_kitchen: kitchen.kitchenId, p_date: d, p_slot: s }))),
          supabase.rpc('change_feed', { p_kitchen: kitchen.kitchenId, p_limit: 20 }),
        ]);
        const error = results.find((r) => r.error)?.error ?? feed.error;
        return { data: { slots: results.map((r) => r.data as unknown as SlotSummary).filter(Boolean), changes: feed.data ?? [] }, error };
      },
      onCached: (d, savedAt) => {
        setSlots(d.slots);
        setChanges(d.changes);
        setStale({ savedAt, offline: false, error: '', updating: true });
      },
    });
    if (res.data) {
      setSlots(res.data.slots);
      setChanges(res.data.changes);
    }
    setStale(res.stale);
    if (kitchen.role === 'owner') {
      // Onboarding: what is left before the kitchen can take customers from the platform.
      const { data } = await supabase.rpc('kitchen_checklist', { p_kitchen: kitchen.kitchenId });
      setTodo(((data ?? []) as { key: string; done: boolean }[]).filter((i) => !i.done).map((i) => i.key));
    }
  }, [kitchen, scope]);

  useFocusEffect(useCallback(() => void load(), [load]));

  if (kitchen.role === 'rider') return <Redirect href="/rider" />;
  if (kitchen.role === 'accountant') {
    return (
      <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
        <Title>{kitchen.kitchenName}</Title>
        <MoneyOverview kitchenId={kitchen.kitchenId} role={kitchen.role} version={version} />
      </ScrollView>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
    >
      <Title>{kitchen.kitchenName}</Title>
      <StaleBanner stale={stale} />
      {todo.length > 0 && (
        <Card>
          <Text style={styles.cardTitle}>{t('checklist.title')}</Text>
          {todo.map((key) => <Muted key={key}>• {t(`checklist.${key}`)}</Muted>)}
          <Muted>{t('checklist.web')}</Muted>
        </Card>
      )}
      {isLead(kitchen.role) && <LeadCards kitchenId={kitchen.kitchenId} version={version} />}
      <SpecialsCard kitchenId={kitchen.kitchenId} isOwner={isLead(kitchen.role)} version={version} />
      <View style={styles.grid}>
        {slots.map((s) => (
          <SlotCard
            key={`${s.service_date}-${s.slot}`}
            s={s}
            kitchenId={kitchen.kitchenId}
            canFreeze={isLead(kitchen.role)}
            onFrozen={() => void load()}
            onPress={() => router.push({ pathname: '/sheet', params: { date: s.service_date, slot: s.slot } })}
          />
        ))}
      </View>
      <ClosuresCard kitchenId={kitchen.kitchenId} isOwner={isLead(kitchen.role)} version={version} onChanged={load} />
      <DispatchPhotoCard kitchenId={kitchen.kitchenId} version={version} />
      {isLead(kitchen.role) && <SyncRejectsCard kitchenId={kitchen.kitchenId} version={version} />}
      {/* Wave 3 riders: stop credits to approve, rider cash handovers (owner or manager, D-117). */}
      {isLead(kitchen.role) && <OwnerDesk kitchenId={kitchen.kitchenId} version={version} />}
      {isLead(kitchen.role) && <AtRiskCard kitchenId={kitchen.kitchenId} version={version} />}
      <Card>
        <Text style={styles.cardTitle}>{t('today.changes')}</Text>
        {changes.length === 0 && <Muted>{t('today.noChanges')}</Muted>}
        {changes.map((c) => (
          <View key={c.change_id} style={styles.change}>
            <Text style={styles.changeText}>
              <Text style={{ fontWeight: '600' }}>{c.customer_name}</Text> · {t(`today.type.${c.type}`)} {formatServiceDate(c.from_date, locale())}
              {c.to_date && c.to_date !== c.from_date ? ` – ${formatServiceDate(c.to_date, locale())}` : ''}{c.slot ? ` (${t(`slot.${c.slot}`)})` : ''}
            </Text>
            <Muted>{formatIstShort(c.requested_at, locale())}{c.after_cutoff ? ` · ${t(c.late_waived ? 'today.lateWaived' : 'today.lateCharged')}` : ''}</Muted>
          </View>
        ))}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space(4), gap: space(3) },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space(3) },
  cardTitle: { fontSize: 16, fontWeight: '600', color: colors.ink },
  change: { paddingVertical: space(2), borderTopWidth: 1, borderTopColor: colors.line },
  changeText: { color: colors.inkSoft },
});
