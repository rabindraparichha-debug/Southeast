import { useCallback, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { formatIstShort } from '@tiffin/core';
import { supabase } from '@/lib/supabase';
import { friendlyError } from '@/lib/errors';
import { Button, ErrorText, Input } from '@/components/ui';
import { colors, space } from '@/components/theme';
import { t } from '@/i18n';

type Msg = { id: string; direction: string; body: string | null; handled_by: string; status: string; created_at: string };

export default function Chat() {
  const { id, name } = useLocalSearchParams<{ id: string; name: string }>();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [handoff, setHandoff] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const [{ data }, { data: conv }] = await Promise.all([
      supabase.from('messages').select('id, direction, body, handled_by, status, created_at').eq('conversation_id', id).order('created_at', { ascending: false }).limit(100),
      supabase.from('conversations').select('handoff_open, unread_count').eq('id', id).single(),
    ]);
    setMsgs(data ?? []);
    setHandoff(Boolean(conv?.handoff_open));
    if (conv?.unread_count) await supabase.rpc('mark_conversation_read', { p_conversation: id });
  }, [id]);

  useFocusEffect(useCallback(() => void load(), [load]));

  async function send() {
    setBusy(true);
    setError('');
    const { error } = await supabase.rpc('send_vendor_message', { p_conversation: id, p_body: text });
    if (!error) await supabase.functions.invoke('whatsapp-outbox', { body: {} }).catch(() => undefined);
    setBusy(false);
    if (error) return setError(friendlyError(error));
    setText('');
    await load();
  }

  async function handBack() {
    const { error } = await supabase.rpc('close_conversation', { p_conversation: id });
    if (error) return setError(friendlyError(error));
    await load();
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Stack.Screen options={{ title: name ?? '' }} />
      <FlatList
        inverted
        data={msgs}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ padding: space(3), gap: space(2) }}
        renderItem={({ item }) => {
          const mine = item.direction === 'out';
          const vendor = item.handled_by === 'vendor';
          return (
            <View style={[styles.bubble, mine ? (vendor ? styles.vendor : styles.bot) : styles.customer, { alignSelf: mine ? 'flex-end' : 'flex-start' }]}>
              <Text style={{ color: vendor ? '#fff' : colors.ink }}>{item.body}</Text>
              <Text style={[styles.meta, vendor && { color: '#FFEDD5' }]}>
                {mine ? (vendor ? t('inbox.you') : item.handled_by === 'ai' ? 'AI' : 'Bot') + ' · ' : ''}{formatIstShort(item.created_at)}
              </Text>
            </View>
          );
        }}
      />
      <View style={styles.composer}>
        {handoff && <Button title={t('inbox.handBack')} onPress={handBack} variant="secondary" />}
        <Input value={text} onChangeText={setText} placeholder={t('inbox.placeholder')} multiline testID="reply" />
        <ErrorText>{error}</ErrorText>
        <Button title={t('inbox.send')} onPress={send} busy={busy} disabled={!text.trim()} />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  bubble: { maxWidth: '82%', borderRadius: 16, paddingHorizontal: space(3), paddingVertical: space(2) },
  customer: { backgroundColor: '#DCFCE7' },
  bot: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  vendor: { backgroundColor: colors.brand },
  meta: { fontSize: 10, color: colors.muted, marginTop: 2 },
  composer: { padding: space(3), gap: space(2), borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.card },
});
