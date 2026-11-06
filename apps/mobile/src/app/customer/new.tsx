import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { formatPaise, istDate, normalizePhone } from '@tiffin/core';
import { supabase } from '@/lib/supabase';
import { useKitchen } from '@/lib/session';
import { friendlyError } from '@/lib/errors';
import { Button, Chip, ErrorText, Input, Label } from '@/components/ui';
import { colors, space } from '@/components/theme';
import { t } from '@/i18n';

type Plan = { id: string; name: string; price_per_meal_paise: number };

// Quick add for phone/walk-in customers: name, number, optional plan, save.
export default function NewCustomer() {
  const kitchen = useKitchen();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState({ line1: '', area: '', landmark: '' });
  const [plans, setPlans] = useState<Plan[]>([]);
  const [planId, setPlanId] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase
      .from('plans')
      .select('id, name, price_per_meal_paise')
      .eq('kitchen_id', kitchen.kitchenId)
      .eq('active', true)
      .order('name')
      .then(({ data }) => setPlans(data ?? []));
  }, [kitchen.kitchenId]);

  async function save() {
    setError('');
    if (!normalizePhone(phone)) return setError(t('errors.invalid_phone'));
    if (!consent) return setError(t('errors.consent_required'));
    setBusy(true);
    // The address is optional; without one the rider's stop has no place (added later on the customer page).
    const hasAddress = Object.values(address).some((v) => v.trim());
    const { data: id, error } = await supabase.rpc('create_customer', {
      p_kitchen: kitchen.kitchenId, p_name: name, p_phone: phone, p_consent: consent,
      p_address: hasAddress ? address : undefined,
    });
    if (error || !id) {
      setBusy(false);
      return setError(friendlyError(error));
    }
    if (planId) {
      const { error: subError } = await supabase.from('subscriptions').insert({
        kitchen_id: kitchen.kitchenId, customer_id: id, plan_id: planId, start_date: istDate(), status: 'active',
      });
      if (subError) setError(friendlyError(subError));
    }
    setBusy(false);
    router.replace({ pathname: '/customer/[id]', params: { id } });
  }

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Label>{t('customer.name')}</Label>
      <Input value={name} onChangeText={setName} autoFocus testID="name" />
      <Label>{t('customer.phone')}</Label>
      <Input value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="98610 00001" testID="phone" />
      <Label>{t('customer.flat')}</Label>
      <Input value={address.line1} onChangeText={(v) => setAddress({ ...address, line1: v })} testID="line1" />
      <Label>{t('customer.area')}</Label>
      <Input value={address.area} onChangeText={(v) => setAddress({ ...address, area: v })} testID="area" />
      <Label>{t('customer.landmark')}</Label>
      <Input value={address.landmark} onChangeText={(v) => setAddress({ ...address, landmark: v })} testID="landmark" />
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
      <Pressable style={styles.consent} onPress={() => setConsent(!consent)} accessibilityRole="checkbox" accessibilityState={{ checked: consent }} testID="consent">
        <Text style={styles.box}>{consent ? '☑' : '☐'}</Text>
        <Text style={styles.consentText}>{t('customer.consent')}</Text>
      </Pressable>
      <ErrorText>{error}</ErrorText>
      <Button title={busy ? t('customer.saving') : t('customer.save')} onPress={save} busy={busy} disabled={!name.trim() || !phone.trim()} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space(4), gap: space(2) },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  consent: { flexDirection: 'row', gap: space(2), alignItems: 'flex-start', marginVertical: space(2) },
  box: { fontSize: 20, color: colors.brand },
  consentText: { flex: 1, color: colors.inkSoft },
});
