import { Tabs } from 'expo-router/js-tabs';
import { Text } from 'react-native';
import { useKitchen } from '@/lib/session';
import { colors } from '@/components/theme';
import { t } from '@/i18n';

function icon(emoji: string) {
  const TabIcon = () => <Text style={{ fontSize: 20 }}>{emoji}</Text>;
  return TabIcon;
}

export default function TabsLayout() {
  const { role } = useKitchen();
  const isRider = role === 'rider';
  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: colors.brand, headerTitleStyle: { fontWeight: '600' } }}>
      <Tabs.Screen name="index" options={{ title: t('tabs.today'), tabBarIcon: icon('📋'), href: isRider ? null : undefined }} />
      <Tabs.Screen name="customers" options={{ title: t('tabs.customers'), tabBarIcon: icon('👥'), href: isRider ? null : undefined }} />
      <Tabs.Screen name="stock" options={{ title: t('tabs.stock'), tabBarIcon: icon('📦'), href: isRider ? null : undefined }} />
      <Tabs.Screen name="inbox" options={{ title: t('tabs.inbox'), tabBarIcon: icon('💬'), href: role === 'owner' ? undefined : null }} />
      {/* Owners of small kitchens often deliver themselves. */}
      <Tabs.Screen name="rider" options={{ title: isRider ? t('tabs.rider') : t('tabs.deliver'), tabBarIcon: icon('🛵'), href: isRider || role === 'owner' ? undefined : null }} />
      <Tabs.Screen name="account" options={{ title: t('tabs.account'), tabBarIcon: icon('👤') }} />
    </Tabs>
  );
}
