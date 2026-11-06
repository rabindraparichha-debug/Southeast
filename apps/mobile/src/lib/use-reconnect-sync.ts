import NetInfo from '@react-native-community/netinfo';
import { useEffect } from 'react';
import { syncQueue } from './rider-store';

/**
 * Sends the rider queue (and pending reports to the owner) the moment the phone gets its connection
 * back, instead of waiting for the next minute's timer or the app coming back to the front (those
 * triggers stay: startRiderSync in rider-store.ts). Only a change from offline to online triggers it;
 * the queue rules themselves (backoff, what is final) are unchanged. D-127.
 */
export function useReconnectSync(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let wasOnline: boolean | null = null;
    const unsubscribe = NetInfo.addEventListener((s) => {
      // isInternetReachable is null while unknown: trust isConnected until it is known.
      const online = s.isConnected === true && s.isInternetReachable !== false;
      if (online && wasOnline === false) void syncQueue({ force: true });
      wasOnline = online;
    });
    return unsubscribe;
  }, [enabled]);
}
