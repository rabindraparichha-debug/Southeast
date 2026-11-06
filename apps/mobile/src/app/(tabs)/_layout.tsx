import { Tabs } from 'expo-router/js-tabs';
import { Text } from 'react-native';
import { useKitchen } from '@/lib/session';
import { canDeliver, isKitchen } from '@/lib/roles';
import { useFlags } from '@/lib/flags';
import { colors } from '@/components/theme';
import { t, useLanguage } from '@/i18n';

function icon(emoji: string) {
  const TabIcon = () => <Text style={{ fontSize: 20 }}>{emoji}</Text>;
  return TabIcon;
}

export default function TabsLayout() {
  const { role } = useKitchen();
  const isRider = role === 'rider';
  const accountant = role === 'accountant'; // money only: the home tab shows money, no stock or delivery
  // A new language re-renders every tab (they read t() while rendering). D-130.
  const lang = useLanguage();
  const flags = useFlags();
  return (
    <Tabs key={lang} screenOptions={{ tabBarActiveTintColor: colors.brand, headerTitleStyle: { fontWeight: '600' } }}>
      <Tabs.Screen name="index" options={{ title: accountant ? t('tabs.money') : t('tabs.today'), tabBarIcon: icon(accountant ? '💰' : '📋'), href: isRider ? null : undefined }} />
      <Tabs.Screen name="customers" options={{ title: t('tabs.customers'), tabBarIcon: icon('👥'), href: isRider ? null : undefined }} />
      <Tabs.Screen name="stock" options={{ title: t('tabs.stock'), tabBarIcon: icon('📦'), href: isKitchen(role) ? undefined : null }} />
      {/* The inbox is customer WhatsApp: a Phase 2 switch (D-180); owner only (D-060). */}
      <Tabs.Screen name="inbox" options={{ title: t('tabs.inbox'), tabBarIcon: icon('💬'), href: role === 'owner' && flags.customer_whatsapp ? undefined : null }} />
      {/* Owners (and managers) of small kitchens often deliver themselves. */}
      <Tabs.Screen name="rider" options={{ title: isRider ? t('tabs.rider') : t('tabs.deliver'), tabBarIcon: icon('🛵'), href: canDeliver(role) ? undefined : null }} />
      <Tabs.Screen name="account" options={{ title: t('tabs.account'), tabBarIcon: icon('👤') }} />
    </Tabs>
  );
}
