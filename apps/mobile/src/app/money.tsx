import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet } from 'react-native';
import { Redirect, useFocusEffect } from 'expo-router';
import { useKitchen } from '@/lib/session';
import { canReadMoney } from '@/lib/roles';
import { MoneyOverview } from '@/components/money-overview';
import { space } from '@/components/theme';

// Kitchen money for owners and managers (opened from Today). Accountants see the same on their home tab.
export default function MoneyScreen() {
  const kitchen = useKitchen();
  const [version, setVersion] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  useFocusEffect(useCallback(() => setVersion((v) => v + 1), []));

  if (!canReadMoney(kitchen.role)) return <Redirect href="/" />;
  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); setVersion((v) => v + 1); setRefreshing(false); }} />}
    >
      <MoneyOverview kitchenId={kitchen.kitchenId} role={kitchen.role} version={version} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space(4), gap: space(3) },
});
