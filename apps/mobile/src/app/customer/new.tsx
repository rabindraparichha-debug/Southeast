import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { formatPaise, istDate, normalizePhone, rupeesToPaise } from '@tiffin/core';
import type { BillingMode, DietType, View as DbView } from '@tiffin/db';
import { supabase } from '@/lib/supabase';
import { useKitchen } from '@/lib/session';
import { friendlyError } from '@/lib/errors';
import { billingLabel } from '@/lib/money';
import { Button, Chip, DIET_LABEL, ErrorText, Input, Label, Muted } from '@/components/ui';
import { colors, radius, space } from '@/components/theme';
import { t } from '@/i18n';

type Plan = { id: string; name: string; price_per_meal_paise: number };
type Match = Pick<DbView<'customers_v'>, 'id' | 'name' | 'area' | 'landmark'>;

// Quick add for phone/walk-in customers: name, number, billing, optional plan, address and
// opening balance, save. A number another customer already uses (D-118: siblings, a family
// phone) needs the vendor's confirmation that it is a different person.
export default function NewCustomer() {
  const kitchen = useKitchen();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [diet, setDiet] = useState<DietType>('veg');
  const [billing, setBilling] = useState<BillingMode>('monthly');
  const [plans, setPlans] = useState<Plan[]>([]);
  const [planId, setPlanId] = useState<string | null>(null);
  const [line1, setLine1] = useState('');
  const [landmark, setLandmark] = useState('');
  const [area, setArea] = useState('');
  const [opening, setOpening] = useState('');
  const [advance, setAdvance] = useState(false); // monthly: the opening amount was paid in advance
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [matches, setMatches] = useState<{ code: 'phone_in_use' | 'already_exists'; rows: Match[] } | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null); // saved, but a later step failed

  useEffect(() => {
    supabase
      .from('plans')
      .select('id, name, price_per_meal_paise')
      .eq('kitchen_id', kitchen.kitchenId)
      .eq('active', true)
      .order('name')
      .then(({ data }) => setPlans(data ?? []));
    // New customers start with the kitchen's default billing (monthly unless changed on the web).
    supabase
      .from('kitchen_settings')
      .select('default_billing_mode')
      .eq('kitchen_id', kitchen.kitchenId)
      .maybeSingle()
      .then(({ data }) => { if (data?.default_billing_mode) setBilling(data.default_billing_mode); });
  }, [kitchen.kitchenId]);

  const openCustomer = (id: string) => router.replace({ pathname: '/customer/[id]', params: { id } });

  async function save(allowShared = false) {
    setError('');
    if (!normalizePhone(phone)) return setError(t('errors.invalid_phone'));
    if (!consent) return setError(t('errors.consent_required'));
    const openingPaise = billing === 'monthly' && opening.trim() ? rupeesToPaise(opening.trim()) : null;
    const openingMeals = billing === 'prepaid' && opening.trim() ? Number(opening.trim()) : null;
    if (billing === 'monthly' && opening.trim() && !openingPaise) return setError(t('errors.invalid_amount'));
    if (billing === 'prepaid' && opening.trim() && !(Number.isInteger(openingMeals) && (openingMeals ?? 0) > 0)) {
      return setError(t('errors.invalid_meals'));
    }
    setBusy(true);
    const address = line1.trim() || landmark.trim() || area.trim()
      ? { line1: line1.trim(), landmark: landmark.trim(), area: area.trim() }
      : undefined;
    const { data: id, error: e } = await supabase.rpc('create_customer', {
      p_kitchen: kitchen.kitchenId, p_name: name, p_phone: phone, p_consent: consent, p_diet: diet,
      p_address: address, p_billing_mode: billing, p_allow_shared_phone: allowShared,
    });
    if (e || !id) {
      setBusy(false);
      if (e?.message === 'phone_in_use' || e?.message === 'already_exists') {
        // Show who already has this number (owners and managers can search by full number).
        const { data } = await supabase.rpc('search_customers', { p_kitchen: kitchen.kitchenId, p_q: normalizePhone(phone) ?? phone, p_limit: 20 });
        setMatches({ code: e.message, rows: (data ?? []) as Match[] });
      }
      return setError(friendlyError(e));
    }
    setMatches(null);
    const problems: string[] = [];
    if (planId) {
      const { error: subError } = await supabase.from('subscriptions').insert({
        kitchen_id: kitchen.kitchenId, customer_id: id, plan_id: planId, start_date: istDate(), status: 'active',
      });
      if (subError) problems.push(friendlyError(subError));
    }
    if (openingPaise) {
      // Monthly: dues owed (minus) or an advance already paid (plus), in rupees.
      const { error: balError } = await supabase.rpc('add_balance_entry', {
        p_customer: id, p_type: 'adjust', p_meals: 0, p_reason: t('newCustomer.openingReason'),
        p_amount_paise: advance ? openingPaise : -openingPaise,
      });
      if (balError) problems.push(friendlyError(balError));
    } else if (openingMeals) {
      const { error: balError } = await supabase.rpc('add_balance_entry', {
        p_customer: id, p_type: 'adjust', p_meals: openingMeals, p_reason: t('newCustomer.openingReason'),
      });
      if (balError) problems.push(friendlyError(balError));
    }
    setBusy(false);
    if (problems.length) {
      setCreatedId(id);
      return setError(`${t('newCustomer.savedWithProblems')} ${problems.join(' ')}`);
    }
    openCustomer(id);
  }

  if (createdId) {
    return (
      <ScrollView contentContainerStyle={styles.content}>
        <ErrorText>{error}</ErrorText>
        <Button title={t('newCustomer.openCustomer')} onPress={() => openCustomer(createdId)} />
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Label>{t('customer.name')}</Label>
      <Input value={name} onChangeText={(v) => { setName(v); setMatches(null); }} autoFocus testID="name" />
      <Label>{t('customer.phone')}</Label>
      <Input value={phone} onChangeText={(v) => { setPhone(v); setMatches(null); }} keyboardType="phone-pad" placeholder="98610 00001" testID="phone" />

      <Label>{t('newCustomer.billing')}</Label>
      <View style={styles.chips}>
        {(['monthly', 'prepaid'] as const).map((m) => (
          <Chip key={m} label={billingLabel(m)} selected={billing === m} onPress={() => { setBilling(m); setOpening(''); }} />
        ))}
      </View>
      <Muted>{billing === 'monthly' ? t('newCustomer.monthlyHint') : t('newCustomer.prepaidHint')}</Muted>

      <Label>{t('newCustomer.diet')}</Label>
      <View style={styles.chips}>
        {(['veg', 'nonveg', 'jain'] as const).map((d) => <Chip key={d} label={DIET_LABEL[d]} selected={diet === d} onPress={() => setDiet(d)} />)}
      </View>

      {plans.length > 0 && (
        <>
          <Label>{t('customer.plan')}</Label>
          <View style={styles.chips}>
            {plans.map((p) => (
              <Chip key={p.id} label={`${p.name} · ${formatPaise(p.price_per_meal_paise)}`} selected={planId === p.id} onPress={() => setPlanId(planId === p.id ? null : p.id)} />
            ))}
          </View>
        </>
      )}

      <Label>{t('newCustomer.address')}</Label>
      <Input value={line1} onChangeText={setLine1} placeholder={t('newCustomer.line1')} testID="line1" />
      <Input value={landmark} onChangeText={setLandmark} placeholder={t('newCustomer.landmark')} />
      <Input value={area} onChangeText={setArea} placeholder={t('newCustomer.area')} />

      <Label>{billing === 'monthly' ? t('newCustomer.openingRupees') : t('newCustomer.openingMeals')}</Label>
      {billing === 'monthly' && (
        <View style={styles.chips}>
          <Chip label={t('newCustomer.owes')} selected={!advance} onPress={() => setAdvance(false)} />
          <Chip label={t('newCustomer.advance')} selected={advance} onPress={() => setAdvance(true)} />
        </View>
      )}
      <Input value={opening} onChangeText={setOpening} keyboardType={billing === 'monthly' ? 'decimal-pad' : 'number-pad'} placeholder={t('newCustomer.optional')} />

      <Pressable style={styles.consent} onPress={() => setConsent(!consent)} accessibilityRole="checkbox" accessibilityState={{ checked: consent }} testID="consent">
        <Text style={styles.box}>{consent ? '☑' : '☐'}</Text>
        <Text style={styles.consentText}>{t('customer.consent')}</Text>
      </Pressable>
      <ErrorText>{error}</ErrorText>
      {matches && (
        <View style={styles.matches}>
          {matches.rows.length > 0 && <Text style={styles.matchTitle}>{t('newCustomer.samePhone')}</Text>}
          {matches.rows.map((m) => (
            <Pressable key={m.id!} onPress={() => openCustomer(m.id!)} style={styles.match}>
              <Text style={styles.matchName}>{m.name}</Text>
              <Muted>{[m.landmark, m.area].filter(Boolean).join(', ') || t('newCustomer.open')}</Muted>
            </Pressable>
          ))}
          {matches.code === 'phone_in_use' && (
            <Button title={t('newCustomer.sharedSave')} onPress={() => save(true)} busy={busy} />
          )}
        </View>
      )}
      {!matches && (
        <Button title={busy ? t('customer.saving') : t('customer.save')} onPress={() => save()} busy={busy} disabled={!name.trim() || !phone.trim()} />
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space(4), gap: space(2) },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  consent: { flexDirection: 'row', gap: space(2), alignItems: 'flex-start', marginVertical: space(2) },
  box: { fontSize: 20, color: colors.brand },
  consentText: { flex: 1, color: colors.inkSoft },
  matches: { gap: space(2), backgroundColor: colors.brandSoft, padding: space(3), borderRadius: radius },
  matchTitle: { fontSize: 15, fontWeight: '600', color: colors.ink },
  match: { paddingVertical: space(2), borderTopWidth: 1, borderTopColor: colors.line },
  matchName: { fontSize: 15, fontWeight: '600', color: colors.brand },
});
