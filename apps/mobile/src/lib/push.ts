// Push notifications (audit item 29). Owners register this phone's Expo push token
// (register_device); the push-outbox Edge Function sends their alerts (production sheet at lock,
// 22:00 summary, stock, late deliveries, credits to approve). Needs a development or release build:
// Expo Go cannot receive remote notifications on Android. Android also needs the FCM credentials in
// EAS (docs/RELEASE.md), iOS the APNs key.
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { AndroidImportance } from 'expo-notifications';
import { Platform } from 'react-native';
import { supabase } from './supabase';

const TOKEN_KEY = 'tiffin.push.token';
const ASKED_KEY = 'tiffin.push.asked';

/** Android channel the server sends to (supabase/functions/_shared/push.ts ANDROID_CHANNEL). */
export const PUSH_CHANNEL = 'alerts';

/** Screens a notification may open (the server sends one of these as data.path). */
const PATHS = new Set(['/', '/notifications', '/handover', '/stock', '/inbox', '/customers']);

export type PushStatus = 'registered' | 'denied' | 'unsupported' | 'error';

let handlerSet = false;
/** Show alerts as a banner even while the app is open. */
export function configureNotifications() {
  if (handlerSet || Platform.OS === 'web') return;
  handlerSet = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
  });
}

/**
 * Asks for permission (once per install unless `ask` is forced) and saves the token for the
 * signed-in member. Safe to call on every start: the server only refreshes the row.
 */
export async function registerForPush(opts: { ask?: boolean } = {}): Promise<PushStatus> {
  if (Platform.OS === 'web' || !Device.isDevice) return 'unsupported';
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(PUSH_CHANNEL, {
        name: 'Kitchen alerts',
        importance: AndroidImportance.HIGH,
      });
    }
    let perm = await Notifications.getPermissionsAsync();
    if (!perm.granted) {
      const asked = await AsyncStorage.getItem(ASKED_KEY);
      if (asked && !opts.ask) return 'denied';
      await AsyncStorage.setItem(ASKED_KEY, '1');
      perm = await Notifications.requestPermissionsAsync();
      if (!perm.granted) return 'denied';
    }
    const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
    const { data: token } = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    const { error } = await supabase.rpc('register_device', {
      p_token: token,
      p_platform: Platform.OS === 'ios' ? 'ios' : 'android',
      p_app_version: Constants.expoConfig?.version ?? undefined,
      p_device_name: Device.modelName ?? undefined,
    });
    if (error) return 'error';
    await AsyncStorage.setItem(TOKEN_KEY, token);
    return 'registered';
  } catch {
    // No FCM/APNs credentials in this build, no network, emulator: alerts stay in the app list.
    return 'error';
  }
}

/** On sign-out: this phone stops receiving the member's alerts. Never blocks sign-out. */
export async function unregisterPush(): Promise<void> {
  try {
    const token = await AsyncStorage.getItem(TOKEN_KEY);
    if (!token) return;
    await supabase.rpc('unregister_device', { p_token: token });
    await AsyncStorage.removeItem(TOKEN_KEY);
  } catch {
    // Offline sign-out: the token moves to whoever signs in next on this phone.
  }
}

/** The screen a tapped notification should open, if it is one we know. */
export function pathOf(response: Notifications.NotificationResponse | null | undefined): string | null {
  const path = response?.notification.request.content.data?.path;
  return typeof path === 'string' && PATHS.has(path) ? path : null;
}
