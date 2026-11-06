import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  RESEND_SECONDS, alternateChannel, formatPhone, loginErrorKey, normalizePhone, parseLoginChannels, retryAfterSeconds,
  type LoginChannel,
} from '@tiffin/core';
import { loadServerOverride, saveServerOverride, supabase } from '@/lib/supabase';
import { friendlyError } from '@/lib/errors';
import { ALLOW_SERVER_SWITCH, IS_DEV } from '@/lib/env';
import { LegalLinks } from '@/components/legal-links';
import { Button, Card, ErrorText, Input, Label, Muted, Title } from '@/components/ui';
import { colors, space } from '@/components/theme';
import { t } from '@/i18n';

// Login by phone code (docs/LOGIN.md). EXPO_PUBLIC_LOGIN_CHANNELS, e.g. "whatsapp,sms": the first is
// the default, the other is offered as "instead" once a code was asked for (or sending failed).
// Inlined at build time; unset means SMS only (the local stack's test numbers).
const CHANNELS = parseLoginChannels(process.env.EXPO_PUBLIC_LOGIN_CHANNELS);
const PRIMARY: LoginChannel = CHANNELS[0] ?? 'sms';

/** signInWithOtp / verifyOtp errors → text (Auth codes and the auth-send-sms hook's codes). */
function loginError(error: { code?: string; message?: string; status?: number }): string {
  const key = loginErrorKey(error);
  return key ? t(`errors.${key}`) : friendlyError(error);
}

export default function Login() {
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [phoneInput, setPhoneInput] = useState('');
  const [phone, setPhone] = useState('');
  const [channel, setChannel] = useState<LoginChannel>(PRIMARY);
  const [otp, setOtp] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(0);
  const [sendFailed, setSendFailed] = useState(false);
  const [server, setServer] = useState<{ url: string; anonKey: string } | null>(null);
  const [editServer, setEditServer] = useState(false);
  const [serverSaved, setServerSaved] = useState(false);

  useEffect(() => {
    if (ALLOW_SERVER_SWITCH) void loadServerOverride().then(setServer);
  }, []);

  useEffect(() => {
    if (wait <= 0) return;
    const id = setTimeout(() => setWait((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [wait]);

  async function sendCode(via: LoginChannel, target: string): Promise<boolean> {
    setError('');
    setNotice('');
    setBusy(true);
    const { error } = await supabase.auth.signInWithOtp({ phone: target, options: { channel: via } });
    setBusy(false);
    if (error) {
      const key = loginErrorKey(error);
      if (key === 'over_sms_send_rate_limit') setWait(retryAfterSeconds(error.message) ?? RESEND_SECONDS);
      setSendFailed(key === 'sms_send_failed');
      setError(loginError(error));
      return false;
    }
    setSendFailed(false);
    setPhone(target);
    setChannel(via);
    setOtp('');
    setWait(RESEND_SECONDS);
    return true;
  }

  async function start(via: LoginChannel) {
    const e164 = normalizePhone(phoneInput);
    if (!e164) return setError(t('errors.invalid_phone'));
    if (await sendCode(via, e164)) setStep('otp');
  }

  async function resend(via: LoginChannel) {
    if (await sendCode(via, phone)) setNotice(t(`login.resent.${via}`));
  }

  async function verify() {
    setError('');
    setNotice('');
    setBusy(true);
    // WhatsApp and SMS codes are both verified as type 'sms'.
    const { error } = await supabase.auth.verifyOtp({ phone, token: otp.trim(), type: 'sms' });
    setBusy(false);
    // On success the auth listener updates the session and the root layout navigates.
    if (error) setError(loginError(error));
  }

  const other = alternateChannel(CHANNELS, step === 'phone' ? PRIMARY : channel);

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.wrap}>
        <View style={styles.header}>
          <Text style={styles.logo}>🍱</Text>
          <Title>{t('app.name')}</Title>
          <Muted>{t('login.title')}</Muted>
        </View>
        <Card>
          {step === 'phone' ? (
            <>
              <Label>{t('login.phone')}</Label>
              <Input value={phoneInput} onChangeText={(v) => { setPhoneInput(v); setWait(0); }} keyboardType="phone-pad" placeholder="98610 00001" autoFocus testID="phone" />
              <ErrorText>{error}</ErrorText>
              <Button
                title={busy ? t('login.sending') : wait > 0 ? t('login.tryAgainIn', { seconds: wait }) : t(`login.send.${PRIMARY}`)}
                onPress={() => void start(PRIMARY)} busy={busy} disabled={wait > 0}
              />
              {other && sendFailed && (
                <Pressable onPress={() => void start(other)} disabled={busy}>
                  <Text style={styles.action}>{t(`login.instead.${other}`)}</Text>
                </Pressable>
              )}
              {PRIMARY === 'whatsapp' && other === 'sms' && !sendFailed && <Muted>{t('login.smsLater')}</Muted>}
              {IS_DEV && <Muted>{t('login.devHint')}</Muted>}
              {ALLOW_SERVER_SWITCH && server && !editServer && (
                <Pressable onPress={() => setEditServer(true)}>
                  <Muted>{t('login.server', { host: server.url.replace(/^https?:\/\//, '') })}</Muted>
                </Pressable>
              )}
              {ALLOW_SERVER_SWITCH && server && editServer && (
                <View style={{ gap: space(2) }}>
                  <Label>{t('login.serverUrl')}</Label>
                  <Input value={server.url} onChangeText={(url) => setServer({ ...server, url })} autoCapitalize="none" placeholder="http://192.168.1.20:54321" />
                  <Label>{t('login.serverKey')}</Label>
                  <Input value={server.anonKey} onChangeText={(anonKey) => setServer({ ...server, anonKey })} autoCapitalize="none" />
                  <Button title={t('login.serverSave')} variant="secondary" onPress={async () => {
                    await saveServerOverride({ url: server.url.trim().replace(/\/$/, ''), anonKey: server.anonKey.trim() });
                    setServerSaved(true);
                    setEditServer(false);
                  }} />
                </View>
              )}
              {serverSaved && <Muted>{t('login.serverRestart')}</Muted>}
            </>
          ) : (
            <>
              <Muted>{t(`login.sent.${channel}`, { phone: formatPhone(phone) })}</Muted>
              <Label>{t('login.code')}</Label>
              <Input value={otp} onChangeText={setOtp} keyboardType="number-pad" maxLength={6} autoFocus textContentType="oneTimeCode" autoComplete="sms-otp" testID="otp" />
              <ErrorText>{error}</ErrorText>
              {notice !== '' && <Text style={styles.notice}>{notice}</Text>}
              <Button title={busy ? t('login.checking') : t('login.verify')} onPress={verify} busy={busy} disabled={otp.trim().length < 6} />
              {wait > 0 ? (
                <Text style={styles.link}>{t('login.waitResend', { seconds: wait })}</Text>
              ) : (
                <>
                  {other && (
                    <Pressable onPress={() => void resend(other)} disabled={busy} testID="login-instead">
                      <Text style={styles.action}>{t(`login.instead.${other}`)}</Text>
                    </Pressable>
                  )}
                  <Pressable onPress={() => void resend(channel)} disabled={busy} testID="login-resend">
                    <Text style={styles.link}>{t(`login.resend.${channel}`)}</Text>
                  </Pressable>
                </>
              )}
              <Pressable onPress={() => { setStep('phone'); setError(''); setNotice(''); setWait(0); setSendFailed(false); }}>
                <Text style={styles.link}>{t('login.changeNumber')}</Text>
              </Pressable>
            </>
          )}
        </Card>
        <LegalLinks />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  wrap: { flex: 1, justifyContent: 'center', padding: space(5), gap: space(5) },
  header: { alignItems: 'center', gap: space(1) },
  logo: { fontSize: 44 },
  link: { color: colors.muted, textAlign: 'center', marginTop: space(2) },
  action: { color: colors.brand, fontWeight: '600', textAlign: 'center', marginTop: space(3) },
  notice: { color: colors.brand, textAlign: 'center' },
});
