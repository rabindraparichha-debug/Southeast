import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { AuthProvider, useAuth } from '@/lib/session';
import { startRiderSync } from '@/lib/rider-store';
import { useReconnectSync } from '@/lib/use-reconnect-sync';
import { installGlobalErrorHandler } from '@/lib/monitor';
import { colors } from '@/components/theme';
import { loadLanguage, t, useLanguage } from '@/i18n';

SplashScreen.preventAutoHideAsync();
installGlobalErrorHandler();

function RootStack() {
  const { ready: authReady, session, kitchen } = useAuth();
  // The language saved on this phone (D-130); screen titles below follow a change at once.
  useLanguage();
  const [langReady, setLangReady] = useState(false);
  useEffect(() => void loadLanguage().finally(() => setLangReady(true)), []);
  const ready = authReady && langReady;
  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);
  const signedIn = Boolean(session);
  // Queued rider actions sync from any screen (and when the app comes back to the front, or the
  // network comes back), not only while the Rider tab is open.
  useEffect(() => (signedIn ? startRiderSync() : undefined), [signedIn]);
  useReconnectSync(signedIn);
  if (!ready) return null;

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
        <Stack.Screen name="money" options={{ title: t('tabs.money') }} />
        <Stack.Screen name="requests" options={{ title: t('lead.requests') }} />
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
