import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { WEEKDAYS, formatServiceDate, istDate } from '@tiffin/core';
import { friendlyError } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { t } from '@/i18n';
import { Button, Card, Chip, ErrorText, Input, Label, Muted } from './ui';
import { colors, radius, space } from './theme';

// Same list as private.health_tag_list() in the database.
export const HEALTH_TAGS = ['diabetic', 'low_salt', 'low_oil', 'low_spice', 'no_onion_garlic', 'soft_food'] as const;

type Row = {
  payer_customer_id: string | null;
  office_id: string | null;
  observes_veg_days: boolean;
  observes_kartika: boolean;
  referral_code: string | null;
};
type Health = { tags: string[]; consent_at: string; consent_basis: string };
type Office = { id: string; name: string; active: boolean; billing_customer_id: string | null };
type Score = { complaints: number; meals: number; complaints_per_100_meals: number | null; first_complaint_credited: boolean };
type Settings = { veg_days: number[]; veg_days_enabled: boolean; kartika_veg_mode: boolean };
type Person = { id: string; name: string };

/**
 * P5/P6 customer details: food preferences, health needs (with consent), who pays, office,
 * referral code and complaint score. Owners edit; staff see food preferences, health needs and the
 * office only (no money, no phone numbers). Riders never reach this screen.
 */
export function CustomerExtras({ customerId, kitchenId, isOwner }: { customerId: string; kitchenId: string; isOwner: boolean }) {
  const [row, setRow] = useState<Row | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [offices, setOffices] = useState<Office[]>([]);
  const [payer, setPayer] = useState<Person | null>(null);
  const [dependents, setDependents] = useState<Person[]>([]);
  const [score, setScore] = useState<Score | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [kartikaNow, setKartikaNow] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [version, setVersion] = useState(0); // bumped after every save to reload

  useEffect(() => {
    let alive = true;
    void (async () => {
      const today = istDate();
      const [c, h, o, dep, cal] = await Promise.all([
        supabase.from('customers').select('payer_customer_id, office_id, observes_veg_days, observes_kartika, referral_code').eq('id', customerId).maybeSingle(),
        supabase.from('customer_health').select('tags, consent_at, consent_basis').eq('customer_id', customerId).maybeSingle(),
        supabase.rpc('offices_list', { p_kitchen: kitchenId }),
        isOwner ? supabase.from('customers').select('id, name').eq('payer_customer_id', customerId).is('deleted_at', null).order('name')
                : Promise.resolve({ data: [] as Person[] }),
        supabase.from('food_calendar').select('id').eq('kind', 'kartika').lte('starts_on', today).gte('ends_on', today).limit(1),
      ]);
      if (!alive) return;
      const r = c.data as Row | null;
      setRow(r);
      setHealth(h.data as Health | null);
      setOffices((o.data ?? []) as unknown as Office[]);
      setDependents((dep.data ?? []) as Person[]);
      setKartikaNow((cal.data ?? []).length > 0);
      if (isOwner) {
        const [p, sc, ks] = await Promise.all([
          r?.payer_customer_id ? supabase.from('customers').select('id, name').eq('id', r.payer_customer_id).maybeSingle() : Promise.resolve({ data: null }),
          supabase.rpc('customer_complaint_score', { p_customer: customerId }),
          supabase.from('kitchen_settings').select('veg_days, veg_days_enabled, kartika_veg_mode').eq('kitchen_id', kitchenId).maybeSingle(),
        ]);
        if (!alive) return;
        setPayer(p.data as Person | null);
        setScore(sc.data as unknown as Score | null);
        setSettings(ks.data as Settings | null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [customerId, kitchenId, isOwner, version]);

  const done = async (e: { message?: string; code?: string } | null, message: string) => {
    if (e) {
      setSaved('');
      setError(friendlyError(e));
      return false;
    }
    setError('');
    setSaved(message);
    setVersion((v) => v + 1);
    return true;
  };

  if (!row) return null;
  const office = offices.find((o) => o.id === row.office_id) ?? null;

  const setPrefs = async (patch: { p_veg_days?: boolean; p_kartika?: boolean }) => {
    const { error: e } = await supabase.rpc('set_customer_food_prefs', { p_customer: customerId, ...patch });
    await done(e, t('actions.saved'));
  };

  return (
    <>
      <Card>
        <Label>{t('prefs.title')}</Label>
        <Toggle label={t('prefs.vegDays')} value={row.observes_veg_days} disabled={!isOwner}
          onChange={(v) => setPrefs({ p_veg_days: v })} />
        {settings && (
          <Muted>
            {settings.veg_days_enabled
              ? t('prefs.vegDaysOn', { days: settings.veg_days.map((d) => WEEKDAYS.find((w) => w.iso === d)?.short ?? d).join(', ') })
              : t('prefs.vegDaysOff')}
          </Muted>
        )}
        <Toggle label={t('prefs.kartika')} value={row.observes_kartika} disabled={!isOwner}
          onChange={(v) => setPrefs({ p_kartika: v })} />
        {settings && !settings.kartika_veg_mode && <Muted>{t('prefs.kartikaOff')}</Muted>}
        {kartikaNow && <Muted>{t('prefs.kartikaNow')}</Muted>}
        {!isOwner && <Muted>{t('prefs.ownerOnly')}</Muted>}
      </Card>

      {/* Keyed by the saved tags: the form starts again from them after every save. */}
      <HealthCard key={`${health?.tags.join(',') ?? ''}|${health?.consent_at ?? ''}`} customerId={customerId} isOwner={isOwner} health={health} onDone={done} />

      <Card>
        <Label>{t('office.title')}</Label>
        <Text style={styles.value}>{office ? `🏢 ${t('office.member', { name: office.name })}` : t('office.none')}</Text>
        {isOwner && (
          <>
            {offices.filter((o) => o.active).length === 0 ? (
              <Muted>{t('office.noOffices')}</Muted>
            ) : (
              <View style={styles.chips}>
                {offices.filter((o) => o.active).map((o) => (
                  <Chip key={o.id} label={o.name} selected={o.id === row.office_id}
                    onPress={async () => {
                      if (o.id === row.office_id) return;
                      const { error: e } = await supabase.rpc('set_customer_office', { p_customer: customerId, p_office: o.id });
                      await done(e, t('actions.saved'));
                    }} />
                ))}
                {row.office_id && (
                  <Chip label={t('office.remove')} selected={false}
                    onPress={async () => {
                      const { error: e } = await supabase.rpc('set_customer_office', { p_customer: customerId });
                      await done(e, t('actions.saved'));
                    }} />
                )}
              </View>
            )}
            <Muted>{t('office.hint')}</Muted>
          </>
        )}
      </Card>

      {isOwner && (
        <PayerCard customerId={customerId} kitchenId={kitchenId} payer={payer} dependents={dependents}
          inOffice={Boolean(office && office.billing_customer_id === row.payer_customer_id && row.payer_customer_id)} onDone={done} />
      )}

      {isOwner && (
        <Card>
          <Label>{t('referral.title')}</Label>
          <Text style={styles.code} selectable>{row.referral_code ?? '—'}</Text>
          <Muted>{t('referral.hint')}</Muted>
          {score && (
            <>
              <Label>{t('complaints.title')}</Label>
              <Text style={styles.value}>
                {t('complaints.summary', { n: score.complaints, meals: score.meals })}
                {score.complaints_per_100_meals != null ? ` · ${t('complaints.rate', { rate: score.complaints_per_100_meals })}` : ''}
              </Text>
              {score.first_complaint_credited && <Muted>{t('complaints.firstCredited')}</Muted>}
            </>
          )}
        </Card>
      )}

      {saved ? <Text style={styles.saved}>✓ {saved}</Text> : null}
      <ErrorText>{error}</ErrorText>
    </>
  );
}

type Done = (e: { message?: string; code?: string } | null, message: string) => Promise<boolean>;

function Toggle({ label, value, disabled, onChange }: { label: string; value: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={styles.toggle}>
      <Text style={styles.toggleLabel}>{label}</Text>
      <Switch value={value} disabled={disabled} onValueChange={onChange}
        trackColor={{ true: colors.brand, false: colors.line }} thumbColor="#fff" />
    </View>
  );
}

function HealthCard({ customerId, isOwner, health, onDone }: { customerId: string; isOwner: boolean; health: Health | null; onDone: Done }) {
  const current = health?.tags ?? [];
  const [tags, setTags] = useState<string[]>(current);
  const [consent, setConsent] = useState(false); // asked again for every change
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const changed = [...tags].sort().join(',') !== [...current].sort().join(',');

  const save = async () => {
    setError('');
    if (tags.length > 0 && !consent) return setError(t('healthTags.consentNeeded'));
    setBusy(true);
    const { error: e } = await supabase.rpc('set_health_tags', { p_customer: customerId, p_tags: tags, p_consent: tags.length > 0 && consent });
    setBusy(false);
    if (e?.message === 'consent_required') return setError(t('healthTags.consentNeeded'));
    await onDone(e, tags.length ? t('actions.saved') : t('healthTags.removed'));
  };

  const remove = async () => {
    setError('');
    setBusy(true);
    const { error: e } = await supabase.rpc('set_health_tags', { p_customer: customerId, p_tags: [], p_consent: false });
    setBusy(false);
    await onDone(e, t('healthTags.removed'));
  };

  return (
    <Card>
      <Label>{t('healthTags.title')}</Label>
      {!isOwner && (
        current.length ? (
          <View style={styles.chips}>{current.map((tag) => <Text key={tag} style={styles.tag}>{t(`health.${tag}`)}</Text>)}</View>
        ) : <Muted>{t('healthTags.none')}</Muted>
      )}
      {isOwner && (
        <>
          <View style={styles.chips}>
            {HEALTH_TAGS.map((tag) => (
              <Chip key={tag} label={t(`health.${tag}`)} selected={tags.includes(tag)}
                onPress={() => setTags(tags.includes(tag) ? tags.filter((x) => x !== tag) : [...tags, tag])} />
            ))}
          </View>
          {health && (
            <Muted>{t('healthTags.consentAt', { date: formatServiceDate(istDate(new Date(health.consent_at))), basis: t(`healthTags.basis.${health.consent_basis}`) })}</Muted>
          )}
          {changed && tags.length > 0 && (
            <Pressable style={styles.consent} onPress={() => setConsent(!consent)} accessibilityRole="checkbox" accessibilityState={{ checked: consent }}>
              <Text style={styles.box}>{consent ? '☑' : '☐'}</Text>
              <Text style={styles.consentText}>{t('healthTags.consent')}</Text>
            </Pressable>
          )}
          <ErrorText>{error}</ErrorText>
          {changed && (
            <Button title={tags.length ? t('healthTags.save') : t('healthTags.remove')} onPress={save} busy={busy}
              disabled={tags.length > 0 && !consent} />
          )}
          {!changed && current.length > 0 && (
            <Pressable onPress={remove} disabled={busy}><Text style={styles.danger}>{t('healthTags.remove')}</Text></Pressable>
          )}
        </>
      )}
      <Muted>{t('healthTags.hint')}</Muted>
    </Card>
  );
}

function PayerCard({ customerId, kitchenId, payer, dependents, inOffice, onDone }: {
  customerId: string; kitchenId: string; payer: Person | null; dependents: Person[]; inOffice: boolean; onDone: Done;
}) {
  const [picking, setPicking] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Person[]>([]);

  const term = picking ? q.trim() : '';
  useEffect(() => {
    if (term.length < 2) return;
    let alive = true;
    const timer = setTimeout(async () => {
      const { data } = await supabase.rpc('search_customers', { p_kitchen: kitchenId, p_q: term, p_limit: 8 });
      if (alive) setResults((data ?? []).filter((c) => c.id !== customerId).map((c) => ({ id: c.id, name: c.name })));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [term, kitchenId, customerId]);
  const shown = term.length >= 2 ? results : [];

  const choose = async (id: string | null) => {
    const { error: e } = await supabase.rpc('set_payer', id ? { p_customer: customerId, p_payer: id } : { p_customer: customerId });
    if (await onDone(e, t('actions.saved'))) {
      setPicking(false);
      setQ('');
    }
  };

  return (
    <Card>
      <Label>{t('payer.title')}</Label>
      {payer ? (
        <Pressable onPress={() => router.push({ pathname: '/customer/[id]', params: { id: payer.id } })}>
          <Text style={styles.value}>{t('payer.paidBy', { name: payer.name })} ›</Text>
        </Pressable>
      ) : dependents.length ? null : <Muted>{t('payer.self')}</Muted>}
      {inOffice && <Muted>{t('payer.office')}</Muted>}
      {dependents.length > 0 && <Text style={styles.value}>{t('payer.paysFor', { names: dependents.map((d) => d.name).join(', ') })}</Text>}
      {!picking && (
        <View style={styles.chips}>
          <Chip label={payer ? t('payer.change') : t('payer.set')} selected={false} onPress={() => setPicking(true)} />
          {payer && <Chip label={t('payer.clear')} selected={false} onPress={() => choose(null)} />}
        </View>
      )}
      {picking && (
        <View style={styles.picker}>
          <Input value={q} onChangeText={setQ} placeholder={t('payer.search')} autoFocus />
          {shown.map((r) => (
            <Pressable key={r.id} onPress={() => choose(r.id)} style={styles.result}>
              <Text style={styles.value}>{r.name}</Text>
            </Pressable>
          ))}
          <Button title={t('actions.back')} variant="secondary" onPress={() => { setPicking(false); setQ(''); }} />
        </View>
      )}
      <Muted>{t('payer.hint')}</Muted>
    </Card>
  );
}

const styles = StyleSheet.create({
  value: { fontSize: 15, color: colors.ink },
  code: { fontSize: 22, fontWeight: '700', letterSpacing: 2, color: colors.ink },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: space(3) },
  toggleLabel: { flex: 1, fontSize: 15, color: colors.inkSoft },
  tag: { fontSize: 13, fontWeight: '600', color: colors.jain, backgroundColor: '#FEF3C7', paddingHorizontal: space(2), paddingVertical: 2, borderRadius: 999, overflow: 'hidden' },
  consent: { flexDirection: 'row', gap: space(2), alignItems: 'flex-start', backgroundColor: colors.brandSoft, padding: space(3), borderRadius: radius },
  box: { fontSize: 20, color: colors.brand, lineHeight: 22 },
  consentText: { flex: 1, fontSize: 14, color: colors.ink },
  danger: { color: colors.danger, textDecorationLine: 'underline', paddingVertical: space(1) },
  picker: { gap: space(2) },
  result: { paddingVertical: space(2), borderTopWidth: 1, borderTopColor: colors.line },
  saved: { color: colors.veg, fontWeight: '600' },
});
