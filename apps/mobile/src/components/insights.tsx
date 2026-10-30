import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SLOT_LABEL, formatPaise, formatServiceDate, istDate } from '@tiffin/core';
import type { Database, MealSlot } from '@tiffin/db';
import { friendlyError } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { t } from '@/i18n';
import { Button, Card, ErrorText, Muted } from './ui';
import { colors, space } from './theme';

type Special = {
  id: string; service_date: string; slot: MealSlot; name: string; description: string | null;
  addon_price_paise: number | null; notified: number; festival: string | null;
};

/** Today's festival specials (owner + staff; the add-on price comes back only for owners). */
export function SpecialsCard({ kitchenId, isOwner, version }: { kitchenId: string; isOwner: boolean; version: number }) {
  const [specials, setSpecials] = useState<Special[] | null>(null);

  useEffect(() => {
    let alive = true;
    const today = istDate();
    supabase.rpc('festival_specials_list', { p_kitchen: kitchenId, p_from: today, p_to: today }).then(({ data }) => {
      if (alive) setSpecials((data ?? []) as unknown as Special[]);
    });
    return () => {
      alive = false;
    };
  }, [kitchenId, version]);

  // Keep the Today screen short: only owners see the card when there is nothing today.
  if (!specials || (specials.length === 0 && !isOwner)) return null;
  return (
    <Card>
      <Text style={styles.title}>🪔 {t('specials.title')}</Text>
      {specials.length === 0 && <Muted>{t('specials.none')}</Muted>}
      {specials.map((s) => (
        <View key={s.id} style={styles.item}>
          <Text style={styles.name}>{s.name} · {SLOT_LABEL[s.slot]}</Text>
          {s.festival ? <Muted>{s.festival}</Muted> : null}
          {s.description ? <Text style={styles.sub}>{s.description}</Text> : null}
          <Text style={styles.sub}>
            {[
              isOwner && s.addon_price_paise != null ? t('specials.addon', { price: formatPaise(s.addon_price_paise) }) : null,
              isOwner && s.notified > 0 ? t('specials.notified', { n: s.notified }) : null,
            ].filter(Boolean).join(' · ')}
          </Text>
        </View>
      ))}
      {isOwner && <Muted>{t('specials.addOnWeb')}</Muted>}
    </Card>
  );
}

type Risk = Database['public']['Functions']['at_risk_customers']['Returns'][number];
type RiskDetail = { balance_meals?: number; skips_7d?: number; open_complaints?: number; paused_since?: string };

function reasonText(reason: string, d: RiskDetail): string {
  switch (reason) {
    case 'balance_out': return t('risk.balance_out', { n: d.balance_meals ?? 0 });
    case 'skips': return t('risk.skips', { n: d.skips_7d ?? 0 });
    case 'open_complaint': return t('risk.open_complaint', { n: d.open_complaints ?? 1 });
    case 'paused_long': return t('risk.paused_long', { date: d.paused_since ? formatServiceDate(istDate(new Date(d.paused_since))) : '—' });
    default: return t(`risk.${reason}`);
  }
}

const SHORT = 5;

/** Owner only: customers likely to stop, with the reasons (computed nightly; can be rechecked). */
export function AtRiskCard({ kitchenId, version }: { kitchenId: string; version: number }) {
  const [rows, setRows] = useState<Risk[] | null>(null);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const fetchRows = useCallback(
    (refresh: boolean) => supabase.rpc('at_risk_customers', { p_kitchen: kitchenId, p_refresh: refresh }),
    [kitchenId],
  );

  useEffect(() => {
    let alive = true;
    fetchRows(false).then(({ data, error: e }) => {
      if (!alive) return;
      setError(e ? friendlyError(e) : '');
      if (!e) setRows(data ?? []);
    });
    return () => {
      alive = false;
    };
  }, [fetchRows, version]);

  const recheck = async () => {
    setBusy(true);
    const { data, error: e } = await fetchRows(true);
    setBusy(false);
    setError(e ? friendlyError(e) : '');
    if (!e) setRows(data ?? []);
  };

  if (!rows) return error ? <Card><ErrorText>{error}</ErrorText></Card> : null;
  const shown = all ? rows : rows.slice(0, SHORT);
  return (
    <Card>
      <Text style={styles.title}>⚠️ {t('risk.title')}{rows.length ? ` (${rows.length})` : ''}</Text>
      {rows.length === 0 ? <Muted>{t('risk.none')}</Muted> : <Muted>{t('risk.hint')}</Muted>}
      {shown.map((r) => (
        <Pressable key={r.customer_id} style={styles.item}
          onPress={() => router.push({ pathname: '/customer/[id]', params: { id: r.customer_id } })}>
          <Text style={styles.name}>{r.customer_name} ›</Text>
          {r.reasons.map((reason) => (
            <Text key={reason} style={styles.reason}>• {reasonText(reason, (r.detail ?? {}) as RiskDetail)}</Text>
          ))}
        </Pressable>
      ))}
      {rows.length > SHORT && (
        <Pressable onPress={() => setAll(!all)}>
          <Text style={styles.link}>{all ? t('risk.showLess') : t('risk.showAll', { n: rows.length })}</Text>
        </Pressable>
      )}
      {rows[0]?.computed_on ? <Text style={styles.small}>{t('risk.checkedOn', { date: formatServiceDate(rows[0].computed_on) })}</Text> : null}
      <ErrorText>{error}</ErrorText>
      <Button title={t('risk.refresh')} variant="secondary" onPress={recheck} busy={busy} />
    </Card>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 16, fontWeight: '600', color: colors.ink },
  item: { paddingVertical: space(2), borderTopWidth: 1, borderTopColor: colors.line, gap: 2 },
  name: { fontSize: 15, fontWeight: '600', color: colors.ink },
  sub: { fontSize: 13, color: colors.inkSoft },
  reason: { fontSize: 13, color: '#B45309' },
  small: { fontSize: 12, color: colors.muted },
  link: { color: colors.brand, fontWeight: '600', paddingVertical: space(1) },
});
