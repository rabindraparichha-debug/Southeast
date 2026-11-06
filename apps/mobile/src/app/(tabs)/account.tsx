import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useAuth, useKitchen } from '@/lib/session';
import { Button, Card, Chip, ErrorText, Label, Muted, Screen } from '@/components/ui';
import { colors, space } from '@/components/theme';
import { useRider } from '@/lib/rider-store';
import { LegalLinks } from '@/components/legal-links';
import { SupportLink } from '@/components/support-link';
import { t } from '@/i18n';

export default function Account() {
  const { memberships, selectKitchen, signOut, session } = useAuth();
  const kitchen = useKitchen();
  const { queue, attention } = useRider();
  const [blocked, setBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const unsynced = queue.length + attention.length;
  const logOut = async () => {
    setBusy(true);
    const done = await signOut();
    setBusy(false);
    setBlocked(!done);
  };
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
      {unsynced > 0 && <Muted>{t('account.unsynced', { n: unsynced })}</Muted>}
      {blocked && unsynced > 0 && <ErrorText>{t('account.logoutBlocked')}</ErrorText>}
      <Button title={t('account.signOut')} onPress={logOut} variant="secondary" disabled={unsynced > 0} busy={busy} />
      <SupportLink fallback={false} />
      <LegalLinks />
    </Screen>
  );
}

const styles = StyleSheet.create({
  value: { fontSize: 16, color: colors.ink, marginBottom: space(2) },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
});
