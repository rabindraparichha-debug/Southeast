// App-wide guards, mounted once in the root layout (inside AuthProvider):
// 1. Minimum app version (audit item 26): when the platform requires a newer build, the app first
//    sends the rider's saved actions, and only then shows "Update required". Nothing queued on the
//    phone is lost to the gate. The setting comes from public.app_config() and is cached for offline.
// 2. Push notifications (audit item 29): owners register this phone; a tapped alert opens its screen.
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { router, type Href } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AppState, Linking, Platform, StyleSheet, Text, View } from 'react-native';
import { isUpdateRequired } from '@tiffin/core';
import { useAuth } from '@/lib/session';
import { loadRider, syncQueue, useRider } from '@/lib/rider-store';
import { configureNotifications, pathOf, registerForPush } from '@/lib/push';
import { supabase } from '@/lib/supabase';
import { Button, Muted } from './ui';
import { colors, space } from './theme';
import { t } from '@/i18n';

type AppConfig = { min_app_version: string | null; android_url: string | null; ios_url: string | null; message: string | null };
const CONFIG_KEY = 'tiffin.appConfig';

async function fetchConfig(): Promise<AppConfig | null> {
  const { data, error } = await supabase.rpc('app_config');
  if (!error && data) {
    await AsyncStorage.setItem(CONFIG_KEY, JSON.stringify(data)).catch(() => undefined);
    return data as unknown as AppConfig;
  }
  const cached = await AsyncStorage.getItem(CONFIG_KEY).catch(() => null);
  return cached ? (JSON.parse(cached) as AppConfig) : null;
}

export function AppGuards({ children }: { children: ReactNode }) {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const refresh = useCallback(() => fetchConfig().then(setCfg), []);
  // Read on start and whenever the app comes back to the front.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void refresh();
    });
    void fetchConfig().then(setCfg);
    return () => sub.remove();
  }, [refresh]);

  usePush();

  const rider = useRider();
  const required = isUpdateRequired(Constants.expoConfig?.version ?? null, cfg?.min_app_version);
  // While an update is required, keep pushing the queue out (the gate waits for it).
  useEffect(() => {
    if (!required) return;
    void loadRider().then(() => syncQueue());
    const timer = setInterval(() => void syncQueue(), 20000);
    return () => clearInterval(timer);
  }, [required]);

  const waiting = !rider.loaded || rider.queue.length > 0;
  const blocked = required && !waiting;
  // The gate replaces the app's screens, which normally hide the splash screen.
  useEffect(() => {
    if (blocked) void SplashScreen.hideAsync();
  }, [blocked]);

  if (!required) return children;
  if (waiting) {
    return (
      <View style={{ flex: 1 }}>
        <View style={styles.banner}>
          <Text style={styles.bannerText}>{t('update.sendingFirst', { n: rider.queue.length })}</Text>
        </View>
        {children}
      </View>
    );
  }
  const url = Platform.OS === 'ios' ? cfg?.ios_url : cfg?.android_url;
  // Actions the server refused stay on this phone (wave 1 "needs attention" list) and show after the update.
  const attention = (rider as { attention?: unknown[] }).attention?.length ?? 0;
  return (
    <View style={styles.gate}>
      <Text style={styles.title}>{t('update.title')}</Text>
      <Muted>{cfg?.message || t('update.body', { version: cfg?.min_app_version ?? '' })}</Muted>
      <Muted>{t('update.current', { version: Constants.expoConfig?.version ?? '?' })}</Muted>
      {attention > 0 && <Muted>{t('update.attention', { n: attention })}</Muted>}
      {url ? <Button title={t('update.download')} onPress={() => void Linking.openURL(url)} /> : <Muted>{t('update.askOwner')}</Muted>}
      <Button title={t('update.checkAgain')} variant="secondary" onPress={() => void refresh()} />
    </View>
  );
}

function usePush() {
  const { session, kitchen, memberships } = useAuth();
  const isOwner = memberships.some((m) => m.role === 'owner');
  const userId = session?.user.id;

  useEffect(() => {
    configureNotifications();
  }, []);

  // Owners get kitchen alerts; registering again on every start keeps the token fresh.
  useEffect(() => {
    if (userId && isOwner) void registerForPush();
  }, [userId, isOwner]);

  // A tapped alert opens its screen (also when the tap started the app).
  useEffect(() => {
    if (Platform.OS === 'web' || !userId || !kitchen) return;
    const open = (r: Notifications.NotificationResponse | null) => {
      const path = pathOf(r);
      if (path) router.push(path as Href);
    };
    void Notifications.getLastNotificationResponseAsync().then((r) => {
      open(r);
      if (r) void Notifications.clearLastNotificationResponseAsync();
    });
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    return () => sub.remove();
  }, [userId, kitchen]);
}

const styles = StyleSheet.create({
  banner: { backgroundColor: '#FEF3C7', paddingTop: space(12), paddingBottom: space(2), paddingHorizontal: space(4) },
  bannerText: { color: colors.ink, fontSize: 14 },
  gate: { flex: 1, justifyContent: 'center', padding: space(6), gap: space(3), backgroundColor: colors.bg },
  title: { fontSize: 24, fontWeight: '700', color: colors.ink },
});
