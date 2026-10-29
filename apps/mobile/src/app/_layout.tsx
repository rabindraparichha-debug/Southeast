import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { AuthProvider, useAuth } from '@/lib/session';
import { installGlobalErrorHandler } from '@/lib/monitor';
import { colors } from '@/components/theme';
import { t } from '@/i18n';

SplashScreen.preventAutoHideAsync();
installGlobalErrorHandler();

function RootStack() {
  const { ready, session, kitchen } = useAuth();
  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);
  if (!ready) return null;

  const signedIn = Boolean(session);
  return (
    <Stack screenOptions={{ headerTintColor: colors.ink, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="login" options={{ headerShown: false }} />
      </Stack.Protected>
      <Stack.Protected guard={signedIn && !kitchen}>
        <Stack.Screen name="onboarding" options={{ title: t('onboarding.title') }} />
      </Stack.Protected>
      <Stack.Protected guard={signedIn && Boolean(kitchen)}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="customer/new" options={{ title: t('customer.new'), presentation: 'modal' }} />
        <Stack.Screen name="customer/[id]" options={{ title: '' }} />
        <Stack.Screen name="sheet" options={{ title: '' }} />
        <Stack.Screen name="chat/[id]" options={{ title: '' }} />
        <Stack.Screen name="stop/[id]" options={{ title: '' }} />
        <Stack.Screen name="stock/purchase" options={{ title: t('stock.purchase.title'), presentation: 'modal' }} />
        <Stack.Screen name="stock/waste" options={{ title: t('stock.waste.title') }} />
        <Stack.Screen name="stock/count" options={{ title: t('stock.count.title') }} />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <StatusBar style="dark" />
      <RootStack />
    </AuthProvider>
  );
}
