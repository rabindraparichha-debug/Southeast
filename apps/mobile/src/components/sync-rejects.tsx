import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { formatIstShort, formatPaise, formatServiceDate } from '@tiffin/core';
import type { SyncReject } from '@tiffin/db';
import { friendlyError } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { locale, t } from '@/i18n';
import { Button, Card, ErrorText, Muted } from './ui';
import { colors, space } from './theme';

/** Why the server refused it, in the owner's words (falls back to the rider-side error text). */
function why(code: string): string {
  const key = `syncRejects.reason.${code}`;
  const text = t(key);
  return text !== key ? text : friendlyError({ message: code });
}

/**
 * Owner only: rider actions the server refused (rider_sync_rejects, D-126), so cash collected at the
 * door is never lost silently. Shown only while something is open.
 */
export function SyncRejectsCard({ kitchenId, version }: { kitchenId: string; version: number }) {
  const [rows, setRows] = useState<SyncReject[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    supabase.rpc('sync_rejects', { p_kitchen: kitchenId }).then(({ data }) => {
      if (alive) setRows(data ?? []);
    });
    return () => {
      alive = false;
    };
  }, [kitchenId, version, reload]);

  if (!rows.length) return null;

  const resolve = async (id: string) => {
    setBusy(id);
    setError('');
    const { error: e } = await supabase.rpc('resolve_sync_reject', { p_id: id });
    setBusy(null);
    if (e) return setError(friendlyError(e));
    setReload((n) => n + 1);
  };

  return (
    <Card style={styles.card}>
      <Text style={styles.title}>⚠ {t('syncRejects.title', { n: rows.length })}</Text>
      <Muted>{t('syncRejects.help')}</Muted>
      {rows.map((r) => {
        const where = [r.customer_name, r.route_name, r.service_date ? formatServiceDate(r.service_date, locale()) : null,
          r.slot ? t(`slot.${r.slot}`) : null].filter(Boolean).join(' · ');
        const extra = [r.cash_paise > 0 ? t('rider.attention.cash', { amount: formatPaise(r.cash_paise) }) : '',
          r.had_photo ? t('syncRejects.photo') : ''].filter(Boolean).join(' · ');
        return (
          <View key={r.id} style={styles.item}>
            <Text style={styles.name}>{t(`rider.attention.kind.${r.action}`)}{where ? `: ${where}` : ''}</Text>
            <Text style={styles.why}>{why(r.error_code)}</Text>
            {extra ? <Text style={styles.cash}>{extra}</Text> : null}
            <Muted>{t('syncRejects.by', { name: r.rider_name ?? t('role.rider'), time: formatIstShort(r.acted_at, locale()) })}</Muted>
            <Button title={t('syncRejects.resolve')} variant="secondary" busy={busy === r.id} onPress={() => void resolve(r.id)} />
          </View>
        );
      })}
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { borderColor: colors.danger },
  title: { fontSize: 16, fontWeight: '700', color: colors.danger },
  item: { gap: 2, paddingTop: space(2), borderTopWidth: 1, borderTopColor: colors.line },
  name: { fontSize: 15, fontWeight: '600', color: colors.ink },
  why: { color: colors.inkSoft },
  cash: { color: colors.danger, fontWeight: '600' },
});
