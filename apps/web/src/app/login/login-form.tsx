'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  RESEND_SECONDS, alternateChannel, formatPhone, loginErrorKey, normalizePhone, retryAfterSeconds, type LoginChannel,
} from '@tiffin/core';
import { supabaseBrowser } from '@/lib/supabase/client';
import { loginErrorText } from '@/lib/errors';
import { Alert, Button, Field, Input } from '@/components/ui';

// Login by phone code (docs/LOGIN.md). `channels` comes from NEXT_PUBLIC_LOGIN_CHANNELS: the first is
// the default, the other is offered as "instead" once a code was asked for (or sending failed).
const SEND_LABEL: Record<LoginChannel, string> = { whatsapp: 'Get code on WhatsApp', sms: 'Send code by SMS' };
const INSTEAD_LABEL: Record<LoginChannel, string> = { whatsapp: 'Get code on WhatsApp instead', sms: 'Send code by SMS instead' };
const RESEND_LABEL: Record<LoginChannel, string> = { whatsapp: 'Resend on WhatsApp', sms: 'Resend SMS' };
const SENT_BY: Record<LoginChannel, string> = { whatsapp: 'on WhatsApp', sms: 'by SMS' };

export function LoginForm({ showDevHint, channels }: { showDevHint: boolean; channels: LoginChannel[] }) {
  const router = useRouter();
  const primary = channels[0] ?? 'sms';
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [phoneInput, setPhoneInput] = useState('');
  const [phone, setPhone] = useState('');
  const [channel, setChannel] = useState<LoginChannel>(primary);
  const [otp, setOtp] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(0);
  const [sendFailed, setSendFailed] = useState(false);

  useEffect(() => {
    if (wait <= 0) return;
    const id = setTimeout(() => setWait((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [wait]);

  async function sendCode(via: LoginChannel, target: string) {
    setError('');
    setNotice('');
    setBusy(true);
    const { error } = await supabaseBrowser().auth.signInWithOtp({ phone: target, options: { channel: via } });
    setBusy(false);
    if (error) {
      const key = loginErrorKey(error);
      if (key === 'over_sms_send_rate_limit') setWait(retryAfterSeconds(error.message) ?? RESEND_SECONDS);
      setSendFailed(key === 'sms_send_failed');
      setError(loginErrorText(error));
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
    if (!e164) return setError('Enter a valid 10-digit Indian mobile number.');
    if (await sendCode(via, e164)) setStep('otp');
  }

  async function resend(via: LoginChannel) {
    if (await sendCode(via, phone)) setNotice(`New code sent ${SENT_BY[via]}.`);
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    const supabase = supabaseBrowser();
    // WhatsApp and SMS codes are both verified as type 'sms'.
    const { error } = await supabase.auth.verifyOtp({ phone, token: otp.trim(), type: 'sms' });
    if (error) {
      setBusy(false);
      return setError(loginErrorText(error));
    }
    // Staff/riders invited before they signed up join their kitchen now.
    await supabase.rpc('claim_invites');
    router.replace('/');
    router.refresh();
  }

  const other = alternateChannel(channels, step === 'phone' ? primary : channel);

  if (step === 'phone') {
    return (
      <form onSubmit={(e) => { e.preventDefault(); void start(primary); }} className="space-y-4">
        <Field label="Mobile number">
          <div className="flex">
            <span className="inline-flex items-center rounded-l-lg bg-ink-100 px-3 text-sm text-ink-600 ring-1 ring-ink-200">+91</span>
            <Input
              className="rounded-l-none"
              inputMode="numeric"
              autoComplete="tel-national"
              placeholder="98610 00001"
              value={phoneInput}
              onChange={(e) => { setPhoneInput(e.target.value); setWait(0); }}
              autoFocus
              required
            />
          </div>
        </Field>
        <Alert>{error}</Alert>
        <Button type="submit" className="w-full" disabled={busy || wait > 0}>
          {busy ? 'Sending…' : wait > 0 ? `Try again in ${wait}s` : SEND_LABEL[primary]}
        </Button>
        {other && sendFailed && (
          <button type="button" className="w-full text-sm text-ink-600 hover:text-ink-900" disabled={busy}
            onClick={() => void start(other)}>
            {INSTEAD_LABEL[other]}
          </button>
        )}
        {primary === 'whatsapp' && other === 'sms' && !sendFailed && (
          <p className="text-center text-xs text-ink-500">No WhatsApp on this number? You can ask for an SMS on the next screen.</p>
        )}
        {showDevHint && (
          <p className="text-center text-xs text-ink-500">Local dev: seed numbers 90000 00001 … use OTP 123456</p>
        )}
      </form>
    );
  }

  return (
    <form onSubmit={verify} className="space-y-4">
      <p className="text-sm text-ink-600">
        Enter the 6-digit code sent {SENT_BY[channel]} to <strong>{formatPhone(phone)}</strong>
      </p>
      <Field label="Code">
        <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value)} autoFocus required />
      </Field>
      <Alert>{error}</Alert>
      {notice && <p className="text-sm text-brand-700" role="status">{notice}</p>}
      <Button type="submit" className="w-full" disabled={busy || otp.trim().length < 6}>
        {busy ? 'Checking…' : 'Log in'}
      </Button>
      <div className="space-y-2 text-center text-sm">
        {wait > 0 ? (
          <p className="text-ink-500" aria-live="polite">Didn&apos;t get it? You can ask again in {wait}s</p>
        ) : (
          <>
            {other && (
              <button type="button" className="block w-full font-medium text-brand-700 hover:underline" disabled={busy} onClick={() => void resend(other)}>
                {INSTEAD_LABEL[other]}
              </button>
            )}
            <button type="button" className="block w-full text-ink-600 hover:text-ink-900" disabled={busy} onClick={() => void resend(channel)}>
              {RESEND_LABEL[channel]}
            </button>
          </>
        )}
        <button type="button" className="block w-full text-ink-500 hover:text-ink-800" onClick={() => { setStep('phone'); setError(''); setNotice(''); setWait(0); setSendFailed(false); }}>
          Use a different number
        </button>
      </div>
    </form>
  );
}
