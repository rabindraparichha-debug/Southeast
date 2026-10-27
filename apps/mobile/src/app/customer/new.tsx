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
    const { data: id, error } = await supabase.rpc('create_customer', {
      p_kitchen: kitchen.kitchenId, p_name: name, p_phone: phone, p_consent: consent,
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
