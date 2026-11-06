import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SLOT_LABEL, addDays, formatServiceDate, istDate } from '@tiffin/core';
import type { MealSlot } from '@tiffin/db';
import { supabase } from '@/lib/supabase';
import { act } from '@/lib/rider-store';
import { ALL_STATUSES, friendlyErrorFor, newClientOp, requestDates, type ChangeRequestRow } from '@/lib/money';
import { t } from '@/i18n';
import { Button, Card, Chip, ErrorText, Input, Label, Muted } from './ui';
import { colors, radius, space } from './theme';

type Kind = 'skip' | 'pause' | 'address';
type Length = 3 | 7 | 14 | null; // pause length in days; null = until resumed

/**
 * At the door a customer says "skip tomorrow" or "pause next week" or "deliver to my new flat".
 * The rider writes it down here; nothing changes until the owner or a manager approves it
 * (rider_request_change, D-117). It goes through the rider offline queue (act()), like every rider
 * write: saved on the phone at once, sent when there is internet, and never counted twice (the
 * queue's client id is the request's idempotency key). A refusal lands in "needs attention".
 * Office stops (several customers) are left to the office's billing contact.
 */
export function RiderRequestCard({ stop, run }: {
  stop: { id: string; customer_id: string; name: string; office?: boolean };
  run: { id: string; kitchen_id: string };
}) {
  const today = istDate();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>('skip');
  const [from, setFrom] = useState(addDays(today, 1));
  const [slot, setSlot] = useState<MealSlot | null>(null);
  const [length, setLength] = useState<Length>(7);
  const [note, setNote] = useState('');
  const [clientOp, setClientOp] = useState(newClientOp);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState('');
  const [mine, setMine] = useState<ChangeRequestRow[]>([]);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (stop.office) return;
    let alive = true;
    void (async () => {
      // Riders see only their own requests. Offline: nothing to show, the form still works.
      const { data } = await supabase.rpc('change_requests_list', { p_kitchen: run.kitchen_id, p_status: ALL_STATUSES, p_limit: 50 });
      if (!alive || !Array.isArray(data)) return;
      setMine((data as unknown as ChangeRequestRow[]).filter((r) => r.customer_id === stop.customer_id).slice(0, 5));
    })();
    return () => {
      alive = false;
    };
  }, [run.kitchen_id, stop.customer_id, stop.office, version]);

  if (stop.office) return null;

  const to = kind === 'skip' ? from : kind === 'pause' && length ? addDays(from, length - 1) : null;

  async function send() {
    setError('');
    if (kind === 'address' && !note.trim()) return setError(t('riderRequest.addressNeeded'));
    setBusy(true);
    const res = await act({
      op: clientOp, kind: 'request', runId: run.id, stopId: stop.id,
      args: {
        p_type: kind, p_from: from, p_to: to ?? undefined,
        p_slot: kind === 'address' ? undefined : slot ?? undefined,
        p_note: note.trim() || undefined,
      },
    });
    setBusy(false);
    if (res.error) return setError(friendlyErrorFor({ message: res.error }, 'rider_request'));
    setSent(t('riderRequest.queued'));
    setOpen(false);
    setNote('');
    setClientOp(newClientOp());
    setVersion((v) => v + 1);
  }

  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i));
  return (
    <Card>
      <Label>{t('riderRequest.title')}</Label>
      {!open && (
        <>
          <Button title={t('riderRequest.open')} variant="secondary" onPress={() => { setSent(''); setError(''); setOpen(true); }} />
          <Muted>{t('riderRequest.hint')}</Muted>
        </>
      )}
      {sent ? <Text style={styles.sent}>✓ {sent}</Text> : null}

      {open && (
        <View style={styles.form}>
          <View style={styles.chips}>
            {(['skip', 'pause', 'address'] as const).map((k) => (
              <Chip key={k} label={t(`riderRequest.kind.${k}`)} selected={kind === k} onPress={() => setKind(k)} />
            ))}
          </View>
          <Label>{kind === 'skip' ? t('riderRequest.which') : t('riderRequest.fromWhen')}</Label>
          <View style={styles.chips}>
            {days.map((d, i) => (
              <Chip key={d} label={i === 0 ? t('stock.purchase.today') : i === 1 ? t('riderRequest.tomorrow') : formatServiceDate(d)}
                selected={from === d} onPress={() => setFrom(d)} />
            ))}
          </View>
          {kind === 'pause' && (
            <>
              <Label>{t('riderRequest.howLong')}</Label>
              <View style={styles.chips}>
                {([3, 7, 14, null] as Length[]).map((n) => (
                  <Chip key={String(n)} label={n ? t('riderRequest.days', { n }) : t('riderRequest.untilResumed')} selected={length === n} onPress={() => setLength(n)} />
                ))}
              </View>
            </>
          )}
          {kind !== 'address' && (
            <>
              <Label>{t('riderRequest.meal')}</Label>
              <View style={styles.chips}>
                <Chip label={t('riderRequest.bothMeals')} selected={slot === null} onPress={() => setSlot(null)} />
                {(['lunch', 'dinner'] as const).map((s) => (
                  <Chip key={s} label={t('requests.slotOnly', { slot: SLOT_LABEL[s] })} selected={slot === s} onPress={() => setSlot(s)} />
                ))}
              </View>
            </>
          )}
          <Label>{kind === 'address' ? t('riderRequest.newAddress') : t('riderRequest.note')}</Label>
          <Input value={note} onChangeText={setNote} multiline={kind === 'address'}
            placeholder={kind === 'address' ? t('riderRequest.addressPlaceholder') : t('riderRequest.notePlaceholder')} />
          <View style={styles.summary}>
            <Text style={styles.summaryText}>
              {t(`requests.type.${kind}`)} · {requestDates({ type: kind, from_date: from, to_date: to, slot: kind === 'address' ? null : slot })}
            </Text>
            <Muted>{t('riderRequest.approvalNeeded', { name: stop.name })}</Muted>
          </View>
          <ErrorText>{error}</ErrorText>
          <Button title={t('riderRequest.send')} onPress={send} busy={busy} />
          <Pressable onPress={() => setOpen(false)}><Text style={styles.link}>{t('actions.back')}</Text></Pressable>
        </View>
      )}

      {mine.length > 0 && (
        <View style={styles.mine}>
          <Muted>{t('riderRequest.yours')}</Muted>
          {mine.map((r) => (
            <Text key={r.id} style={styles.mineRow}>
              {t(`requests.type.${r.type}`)} · {requestDates(r)} · <Text style={{ fontWeight: '600' }}>{t(`requests.status.${r.status}`)}</Text>
            </Text>
          ))}
        </View>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  form: { gap: space(2) },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  summary: { gap: 2, backgroundColor: colors.brandSoft, padding: space(3), borderRadius: radius },
  summaryText: { fontSize: 15, fontWeight: '600', color: colors.ink },
  sent: { color: colors.veg, fontWeight: '600' },
  link: { textAlign: 'center', paddingVertical: space(2), color: colors.inkSoft, textDecorationLine: 'underline' },
  mine: { gap: 2, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: space(2) },
  mineRow: { fontSize: 13, color: colors.inkSoft },
});
