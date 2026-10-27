'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { formatPhone, normalizePhone } from '@tiffin/core';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Alert, Button, Field, Input } from '@/components/ui';

export function LoginForm({ showDevHint }: { showDevHint: boolean }) {
  const router = useRouter();
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [phoneInput, setPhoneInput] = useState('');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function sendOtp(e: FormEvent) {
    e.preventDefault();
    setError('');
    const e164 = normalizePhone(phoneInput);
    if (!e164) return setError('Enter a valid 10-digit Indian mobile number.');
    setBusy(true);
    const { error } = await supabaseBrowser().auth.signInWithOtp({ phone: e164 });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    setPhone(e164);
    setStep('otp');
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    const supabase = supabaseBrowser();
    const { error } = await supabase.auth.verifyOtp({ phone, token: otp.trim(), type: 'sms' });
    if (error) {
      setBusy(false);
      return setError(error.message.toLowerCase().includes('expired') ? 'Code is wrong or expired.' : friendlyError(error));
    }
    // Staff/riders invited before they signed up join their kitchen now.
    await supabase.rpc('claim_invites');
    router.replace('/');
    router.refresh();
  }

  if (step === 'phone') {
    return (
      <form onSubmit={sendOtp} className="space-y-4">
        <Field label="Mobile number">
          <div className="flex">
            <span className="inline-flex items-center rounded-l-lg bg-ink-100 px-3 text-sm text-ink-600 ring-1 ring-ink-200">+91</span>
            <Input
              className="rounded-l-none"
              inputMode="numeric"
              autoComplete="tel-national"
              placeholder="98610 00001"
              value={phoneInput}
              onChange={(e) => setPhoneInput(e.target.value)}
              autoFocus
              required
            />
          </div>
        </Field>
        <Alert>{error}</Alert>
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? 'Sending…' : 'Send OTP'}
        </Button>
        {showDevHint && (
          <p className="text-center text-xs text-ink-500">Local dev: seed numbers 90000 00001 … use OTP 123456</p>
        )}
      </form>
    );
  }

  return (
    <form onSubmit={verify} className="space-y-4">
      <p className="text-sm text-ink-600">
        Enter the 6-digit code sent to <strong>{formatPhone(phone)}</strong>
      </p>
      <Field label="OTP">
        <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value)} autoFocus required />
      </Field>
      <Alert>{error}</Alert>
      <Button type="submit" className="w-full" disabled={busy || otp.trim().length < 6}>
        {busy ? 'Checking…' : 'Log in'}
      </Button>
      <button type="button" className="w-full text-sm text-ink-500 hover:text-ink-800" onClick={() => setStep('phone')}>
        Use a different number
      </button>
    </form>
  );
}
