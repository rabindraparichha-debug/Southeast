import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { formatPhone, normalizePhone } from '@tiffin/core';
import { supabase } from '@/lib/supabase';
import { friendlyError } from '@/lib/errors';
import { IS_DEV } from '@/lib/env';
import { Button, Card, ErrorText, Input, Label, Muted, Title } from '@/components/ui';
import { colors, space } from '@/components/theme';
import { t } from '@/i18n';

export default function Login() {
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [phoneInput, setPhoneInput] = useState('');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function sendOtp() {
    setError('');
    const e164 = normalizePhone(phoneInput);
    if (!e164) return setError(t('errors.invalid_phone'));
    setBusy(true);
    const { error } = await supabase.auth.signInWithOtp({ phone: e164 });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    setPhone(e164);
    setStep('otp');
  }

  async function verify() {
    setError('');
    setBusy(true);
    const { error } = await supabase.auth.verifyOtp({ phone, token: otp.trim(), type: 'sms' });
    setBusy(false);
    // On success the auth listener updates the session and the root layout navigates.
    if (error) setError(t('errors.otp'));
  }

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
              <Input value={phoneInput} onChangeText={setPhoneInput} keyboardType="phone-pad" placeholder="98610 00001" autoFocus testID="phone" />
              <ErrorText>{error}</ErrorText>
              <Button title={busy ? t('login.sending') : t('login.sendOtp')} onPress={sendOtp} busy={busy} />
              {IS_DEV && <Muted>{t('login.devHint')}</Muted>}
            </>
          ) : (
            <>
              <Muted>{t('login.otpSentTo', { phone: formatPhone(phone) })}</Muted>
              <Label>{t('login.otp')}</Label>
              <Input value={otp} onChangeText={setOtp} keyboardType="number-pad" maxLength={6} autoFocus textContentType="oneTimeCode" testID="otp" />
              <ErrorText>{error}</ErrorText>
              <Button title={busy ? t('login.checking') : t('login.verify')} onPress={verify} busy={busy} disabled={otp.trim().length < 6} />
              <Pressable onPress={() => setStep('phone')}>
                <Text style={styles.link}>{t('login.changeNumber')}</Text>
              </Pressable>
            </>
          )}
        </Card>
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
});
