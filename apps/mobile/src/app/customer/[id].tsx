import { useEffect, useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { formatPhone } from '@tiffin/core';
import type { View as DbView } from '@tiffin/db';
import { supabase } from '@/lib/supabase';
import { useKitchen } from '@/lib/session';
import { Button, Card, DIET_COLOR, DIET_LABEL, Label, Muted } from '@/components/ui';
import { colors, space } from '@/components/theme';
import { t } from '@/i18n';

export default function CustomerDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const kitchen = useKitchen();
  const [c, setC] = useState<DbView<'customers_v'> | null>(null);

  useEffect(() => {
    supabase.from('customers_v').select('*').eq('id', id).eq('kitchen_id', kitchen.kitchenId).maybeSingle().then(({ data }) => setC(data));
  }, [id, kitchen.kitchenId]);

  if (!c) return null;
  const canCall = kitchen.role === 'owner' && c.phone && !c.phone.includes('•');

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: c.name ?? '' }} />
      <Card>
        <Text style={styles.name}>{c.name}</Text>
        <Muted>{formatPhone(c.phone)}</Muted>
        {c.diet && <Text style={{ color: DIET_COLOR[c.diet], fontWeight: '600' }}>{DIET_LABEL[c.diet]}</Text>}
        {canCall && <Button title={`📞 ${t('customer.call')}`} onPress={() => Linking.openURL(`tel:${c.phone}`)} variant="secondary" />}
      </Card>
      <Card>
        <Label>{t('customer.address')}</Label>
        <Text style={styles.body}>{[c.line1, c.landmark, c.area].filter(Boolean).join(', ') || t('customer.noAddress')}</Text>
        {c.delivery_notes ? <Muted>{c.delivery_notes}</Muted> : null}
      </Card>
      {c.notes ? (
        <Card>
          <Label>{t('customer.notes')}</Label>
          <Text style={styles.body}>{c.notes}</Text>
        </Card>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space(4), gap: space(3) },
  name: { fontSize: 20, fontWeight: '600', color: colors.ink },
  body: { fontSize: 15, color: colors.inkSoft },
});
