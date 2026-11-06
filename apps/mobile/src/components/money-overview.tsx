import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatPaise, formatServiceDate, istDate } from '@tiffin/core';
import type { BillingMode, MemberRole } from '@tiffin/db';
import { supabase } from '@/lib/supabase';
import { friendlyError } from '@/lib/errors';
import { isLead } from '@/lib/roles';
import { isOfflineError, monthLabel, monthStart } from '@/lib/money';
import { t } from '@/i18n';
import { Button, Card, Chip, ErrorText, Input, Label, Muted } from './ui';
import { colors, radius, space } from './theme';

type Report = {
  collected_paise: number;
  dues_paise: number;
  dues_customers: number;
  pending_cash_paise: number;
  liability_paise: number;
  monthly_customers: number;
  prepaid_customers: number;
};
type Due = { customer_id: string; customer_name: string; meals_owed: number; amount_owed_paise: number; since: string; billing_mode: BillingMode };
type Cash = {
  id: string; amount_paise: number; meals: number; note: string | null; created_at: string; collected_by: string | null;
  customer: { id: string; name: string; billing_mode: BillingMode } | null;
};

const SHOW = 20;

/**
 * Kitchen money at a glance (D-115, D-117): this month's collections, cash riders collected that
 * waits for confirmation, and who owes what (rupees for monthly customers, meals for prepaid).
 * Owners and managers confirm or reject rider cash; accountants read only.
 */
export function MoneyOverview({ kitchenId, role, version }: { kitchenId: string; role: MemberRole; version: number }) {
  const lead = isLead(role);
  const [report, setReport] = useState<Report | null>(null);
  const [dues, setDues] = useState<Due[]>([]);
  const [cash, setCash] = useState<Cash[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [all, setAll] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const today = istDate();
      const [r, d, c, m] = await Promise.all([
        supabase.rpc('money_report', { p_kitchen: kitchenId, p_from: monthStart(today), p_to: today }),
        supabase.rpc('dues_list', { p_kitchen: kitchenId }),
        supabase.from('payments')
          .select('id, amount_paise, meals, note, created_at, collected_by, customer:customers(id, name, billing_mode)')
          .eq('kitchen_id', kitchenId).eq('status', 'pending').order('created_at').limit(100),
        supabase.from('members').select('user_id, display_name').eq('kitchen_id', kitchenId),
      ]);
      if (!alive) return;
      const failed = r.error ?? d.error ?? c.error;
      setError(failed ? (isOfflineError(failed) ? t('money.offline') : friendlyError(failed)) : '');
      if (r.data) setReport(r.data as unknown as Report);
      if (d.data) setDues(d.data as Due[]);
      if (c.data) setCash(c.data as unknown as Cash[]);
      setNames(Object.fromEntries(((m.data ?? []) as { user_id: string; display_name: string | null }[])
        .filter((x) => x.display_name).map((x) => [x.user_id, x.display_name as string])));
    })();
    return () => {
      alive = false;
    };
  }, [kitchenId, version, reload]);

  const shown = all ? dues : dues.slice(0, SHOW);
  return (
    <>
      {report && (
        <Card>
          <Label>{monthLabel(istDate())}</Label>
          <View style={styles.tiles}>
            <Tile label={t('moneyHome.collected')} value={formatPaise(report.collected_paise)} />
            <Tile label={t('moneyHome.dues', { n: report.dues_customers })} value={formatPaise(report.dues_paise)} warn={report.dues_paise > 0} />
            <Tile label={t('moneyHome.pendingCash')} value={formatPaise(report.pending_cash_paise)} warn={report.pending_cash_paise > 0} />
            <Tile label={t('moneyHome.advances')} value={formatPaise(report.liability_paise)} />
          </View>
          <Muted>{t('moneyHome.customers', { monthly: report.monthly_customers, prepaid: report.prepaid_customers })}</Muted>
        </Card>
      )}
      <ErrorText>{error}</ErrorText>
      {saved ? <Text style={styles.saved}>✓ {saved}</Text> : null}

      <Card>
        <Label>{t('moneyHome.cashTitle')}</Label>
        {cash.length === 0 && <Muted>{t('moneyHome.cashNone')}</Muted>}
        {cash.map((c) => (
          <CashLine key={c.id} c={c} rider={c.collected_by ? names[c.collected_by] ?? null : null} lead={lead}
            onDone={(text) => { setSaved(text); setReload((n) => n + 1); }} />
        ))}
      </Card>

      <Card>
        <Label>{t('moneyHome.duesTitle')}</Label>
        {dues.length === 0 && <Muted>{t('moneyHome.duesNone')}</Muted>}
        {shown.map((d) => (
          <Pressable key={d.customer_id} style={styles.row} onPress={() => router.push({ pathname: '/customer/[id]', params: { id: d.customer_id } })}>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{d.customer_name}</Text>
              <Muted>{t(`billing.short.${d.billing_mode}`)} · {t('moneyHome.since', { date: formatServiceDate(d.since) })}</Muted>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={styles.owed}>{formatPaise(d.amount_owed_paise)}</Text>
              {d.billing_mode === 'prepaid' && <Muted>{t('money.owes', { n: d.meals_owed })}</Muted>}
            </View>
          </Pressable>
        ))}
        {dues.length > SHOW && (
          <Pressable onPress={() => setAll(!all)}>
            <Text style={styles.more}>{all ? t('risk.showLess') : t('risk.showAll', { n: dues.length })}</Text>
          </Pressable>
        )}
      </Card>
      <Muted>{t('moneyHome.webHint')}</Muted>
    </>
  );
}

function Tile({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <View style={styles.tile}>
      <Text style={[styles.tileValue, warn && { color: colors.danger }]}>{value}</Text>
      <Text style={styles.tileLabel}>{label}</Text>
    </View>
  );
}

function CashLine({ c, rider, lead, onDone }: { c: Cash; rider: string | null; lead: boolean; onDone: (text: string) => void }) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const prepaid = c.customer?.billing_mode === 'prepaid';

  async function confirm() {
    setBusy(true);
    setError('');
    const { error: e } = await supabase.rpc('confirm_payment', { p_payment: c.id });
    setBusy(false);
    if (e) return setError(friendlyError(e));
    onDone(t('money.cashConfirmed', { amount: formatPaise(c.amount_paise) }));
  }
  async function reject() {
    setBusy(true);
    setError('');
    const { error: e } = await supabase.rpc('reject_payment', { p_payment: c.id, p_reason: reason.trim() || t('money.notReceived') });
    setBusy(false);
    if (e) return setError(friendlyError(e));
    onDone(t('money.cashRejected'));
  }

  return (
    <View style={styles.cash}>
      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Text style={styles.name}>{c.customer?.name ?? '—'}</Text>
          <Muted>
            {formatServiceDate(istDate(new Date(c.created_at)))}{rider ? ` · ${t('moneyHome.by', { name: rider })}` : ''}{c.note ? ` · ${c.note}` : ''}
          </Muted>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={styles.owed}>{formatPaise(c.amount_paise)}</Text>
          {prepaid && c.meals > 0 && <Muted>{t('balance.meals', { n: c.meals })}</Muted>}
        </View>
      </View>
      {lead && !rejecting && (
        <View style={styles.chips}>
          <Chip label={`✓ ${t('money.confirmCash')}`} selected={false} onPress={confirm} />
          <Chip label={t('money.rejectCash')} selected={false} onPress={() => setRejecting(true)} />
        </View>
      )}
      {lead && rejecting && (
        <View style={styles.confirm}>
          <Label>{t('money.rejectWhy')}</Label>
          <Input value={reason} onChangeText={setReason} placeholder={t('money.notReceived')} />
          <Button title={t('money.rejectCash')} onPress={reject} busy={busy} />
          <Button title={t('actions.back')} onPress={() => setRejecting(false)} variant="secondary" />
        </View>
      )}
      {busy && !rejecting && <Muted>{t('customer.saving')}</Muted>}
      <ErrorText>{error}</ErrorText>
    </View>
  );
}

const styles = StyleSheet.create({
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  tile: { flexBasis: '47%', flexGrow: 1, backgroundColor: colors.bg, borderRadius: radius, padding: space(3), gap: 2 },
  tileValue: { fontSize: 18, fontWeight: '700', color: colors.ink },
  tileLabel: { fontSize: 13, color: colors.muted },
  saved: { color: colors.veg, fontWeight: '600' },
  row: { flexDirection: 'row', gap: space(3), paddingVertical: space(2), borderTopWidth: 1, borderTopColor: colors.line },
  cash: { gap: space(1) },
  name: { fontSize: 15, fontWeight: '600', color: colors.ink },
  owed: { fontSize: 15, fontWeight: '700', color: colors.ink },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  confirm: { gap: space(2), backgroundColor: colors.brandSoft, padding: space(3), borderRadius: radius },
  more: { color: colors.brand, fontWeight: '600', paddingVertical: space(2) },
});
