import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/session';
import { useRider } from '@/lib/rider-store';
import { friendlyError } from '@/lib/errors';
import { Button, Card, ErrorText, Input, Label, Muted, Screen } from '@/components/ui';
import { t } from '@/i18n';

export default function Onboarding() {
  const { reload, selectKitchen, signOut } = useAuth();
  const { queue, attention } = useRider();
  const unsynced = queue.length + attention.length;
  const [name, setName] = useState('');
  const [area, setArea] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    setError('');
    const { data, error } = await supabase.rpc('create_kitchen', { p_name: name, p_area: area || undefined });
    if (error || !data) {
      setBusy(false);
      return setError(friendlyError(error));
    }
    await selectKitchen(data.id);
    await reload();
  }

  return (
    <Screen>
      <Muted>{t('onboarding.help')}</Muted>
      <Card>
        <Label>{t('onboarding.name')}</Label>
        <Input value={name} onChangeText={setName} placeholder="Maa Tarini Tiffin" />
        <Label>{t('onboarding.area')}</Label>
        <Input value={area} onChangeText={setArea} placeholder="Patia" />
        <ErrorText>{error}</ErrorText>
        <Button title={t('onboarding.create')} onPress={create} busy={busy} disabled={name.trim().length < 2} />
      </Card>
      {unsynced > 0 && <Muted>{t('account.unsynced', { n: unsynced })}</Muted>}
      {/* Logging out would wipe rider actions still on this phone: blocked until they are sent. */}
      <Button title={t('account.signOut')} onPress={() => void signOut()} variant="secondary" disabled={unsynced > 0} />
    </Screen>
  );
}
