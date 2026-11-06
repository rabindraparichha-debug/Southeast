// In-app alerts list (audit item 29): every alert the kitchen sent this member in the last 30 days,
// whether or not it reached the phone as a push. Texts come from the server (my_notifications).
import { Stack, router, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { formatIstShort } from '@tiffin/core';
import { Button, Card, ErrorText, Muted } from '@/components/ui';
import { colors, radius, space } from '@/components/theme';
import { registerForPush, type PushStatus } from '@/lib/push';
import { supabase } from '@/lib/supabase';
import { t } from '@/i18n';

type Alert = { id: string; title: string; body: string; path: string; kitchen_name: string; created_at: string; template: string };

export default function Notifications() {
  const [items, setItems] = useState<Alert[]>([]);
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [push, setPush] = useState<PushStatus | null>(null);

  const load = useCallback(async () => {
    const { data, error: e } = await supabase.rpc('my_notifications', { p_limit: 100 });
    setError(Boolean(e));
    if (!e) setItems((data ?? []) as unknown as Alert[]);
  }, []);

  useFocusEffect(useCallback(() => void load(), [load]));

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{ title: t('notifications.title') }} />
      <FlatList
        data={items}
        keyExtractor={(a) => a.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
        contentContainerStyle={{ padding: space(4), gap: space(2) }}
        ListHeaderComponent={
          <Card style={{ marginBottom: space(2) }}>
            {push === 'registered' && <Muted>{t('notifications.pushOn')}</Muted>}
            {push === 'denied' && <Muted>{t('notifications.pushOff')}</Muted>}
            {(push === 'unsupported' || push === 'error') && <Muted>{t('notifications.pushUnsupported')}</Muted>}
            {push !== 'registered' && (
              <Button title={t('notifications.enable')} variant="secondary" onPress={async () => setPush(await registerForPush({ ask: true }))} />
            )}
            {error && <ErrorText>{t('notifications.loadFailed')}</ErrorText>}
          </Card>
        }
        ListEmptyComponent={error ? undefined : <Muted>{t('notifications.empty')}</Muted>}
        renderItem={({ item }) => (
          <Pressable onPress={() => router.push(item.path as Href)} style={({ pressed }) => [styles.row, pressed && { opacity: 0.8 }]}>
            <Text style={styles.title}>{item.title}</Text>
            <Text style={styles.body}>{item.body}</Text>
            <Text style={styles.meta}>{item.kitchen_name} · {formatIstShort(item.created_at)}</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { backgroundColor: colors.card, borderRadius: radius, borderWidth: 1, borderColor: colors.line, padding: space(3), gap: 2 },
  title: { fontSize: 16, fontWeight: '600', color: colors.ink },
  body: { fontSize: 14, color: colors.inkSoft },
  meta: { fontSize: 12, color: colors.muted },
});
