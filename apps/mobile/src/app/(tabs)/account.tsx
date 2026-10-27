import { StyleSheet, Text, View } from 'react-native';
import { useAuth, useKitchen } from '@/lib/session';
import { Button, Card, Chip, Label, Muted, Screen } from '@/components/ui';
import { colors, space } from '@/components/theme';
import { t } from '@/i18n';

export default function Account() {
  const { memberships, selectKitchen, signOut, session } = useAuth();
  const kitchen = useKitchen();
  return (
    <Screen>
      <Card>
        <Label>{t('account.kitchen')}</Label>
        <Text style={styles.value}>{kitchen.kitchenName}</Text>
        <Label>{t('account.role')}</Label>
        <Text style={styles.value}>{t(`role.${kitchen.role}`)}</Text>
        <Muted>{session?.user.phone ? `+${session.user.phone}` : ''}</Muted>
      </Card>
      {memberships.length > 1 && (
        <Card>
          <Label>{t('account.switch')}</Label>
          <View style={styles.chips}>
            {memberships.map((m) => (
              <Chip key={m.kitchenId} label={m.kitchenName} selected={m.kitchenId === kitchen.kitchenId} onPress={() => selectKitchen(m.kitchenId)} />
            ))}
          </View>
        </Card>
      )}
      <Button title={t('account.signOut')} onPress={signOut} variant="secondary" />
    </Screen>
  );
}

const styles = StyleSheet.create({
  value: { fontSize: 16, color: colors.ink, marginBottom: space(2) },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
});
