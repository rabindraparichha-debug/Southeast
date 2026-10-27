import { Card, Muted, Screen, Title } from '@/components/ui';
import { useKitchen } from '@/lib/session';
import { t } from '@/i18n';

// Rider mode (stops, navigation, proof, offline sync) is milestone M5.
export default function Rider() {
  const kitchen = useKitchen();
  return (
    <Screen>
      <Title>{kitchen.kitchenName}</Title>
      <Card>
        <Muted>{t('rider.soon')}</Muted>
      </Card>
    </Screen>
  );
}
