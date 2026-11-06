import { describe, expect, it } from 'vitest';
import { RESEND_SECONDS, alternateChannel, loginErrorKey, parseLoginChannels, retryAfterSeconds } from '../src/login';

describe('login channels', () => {
  it('parses the public LOGIN_CHANNELS list (default SMS)', () => {
    expect(parseLoginChannels(undefined)).toEqual(['sms']);
    expect(parseLoginChannels('')).toEqual(['sms']);
    expect(parseLoginChannels('whatsapp,sms')).toEqual(['whatsapp', 'sms']);
    expect(parseLoginChannels(' WhatsApp , telegram, whatsapp ')).toEqual(['whatsapp']);
    expect(parseLoginChannels('sms,whatsapp')).toEqual(['sms', 'whatsapp']);
  });

  it('offers the other channel as "instead"', () => {
    expect(alternateChannel(['whatsapp', 'sms'], 'whatsapp')).toBe('sms');
    expect(alternateChannel(['whatsapp', 'sms'], 'sms')).toBe('whatsapp');
    expect(alternateChannel(['sms'], 'sms')).toBeNull();
  });

  it('reads the wait time from Auth\'s rate-limit message', () => {
    expect(retryAfterSeconds('For security purposes, you can only request this after 37 seconds.')).toBe(37);
    expect(retryAfterSeconds('after 1 second')).toBe(1);
    expect(retryAfterSeconds('SMS rate limit exceeded')).toBeNull();
    expect(RESEND_SECONDS).toBeGreaterThan(0);
  });
});

describe('loginErrorKey', () => {
  it('maps Supabase Auth error codes', () => {
    expect(loginErrorKey({ code: 'over_sms_send_rate_limit', message: 'For security purposes, you can only request this after 4 seconds.' })).toBe('over_sms_send_rate_limit');
    expect(loginErrorKey({ code: 'sms_send_failed', message: 'Error sending confirmation OTP to provider: ...' })).toBe('sms_send_failed');
    expect(loginErrorKey({ code: 'otp_expired', message: 'Token has expired or is invalid' })).toBe('otp_expired');
    expect(loginErrorKey({ code: 'otp_disabled', message: 'Signups not allowed for otp' })).toBe('signup_disabled');
    expect(loginErrorKey({ code: 'hook_timeout', message: 'Failed to reach hook' })).toBe('sms_send_failed');
    expect(loginErrorKey({ code: 'validation_failed', message: 'Invalid phone number format (E.164 required)' })).toBe('invalid_phone');
    expect(loginErrorKey({ code: 'over_request_rate_limit', message: 'Request rate limit reached' })).toBe('over_request_rate_limit');
  });

  it('maps the auth-send-sms hook answers (code arrives as the message)', () => {
    expect(loginErrorKey({ code: 'unknown', message: 'sms_send_failed', status: 422 })).toBe('sms_send_failed');
    expect(loginErrorKey({ message: 'sms_not_configured', status: 500 })).toBe('sms_not_configured');
    expect(loginErrorKey({ code: 'unknown', message: 'phone_not_allowed', status: 400 })).toBe('phone_not_allowed');
    expect(loginErrorKey({ code: 'unexpected_failure', message: 'Unexpected status code returned from hook: 500', status: 500 })).toBe('sms_send_failed');
  });

  it('recognises network failures and leaves the rest alone', () => {
    expect(loginErrorKey({ message: 'Failed to fetch' })).toBe('network');
    expect(loginErrorKey({ message: 'Network request failed' })).toBe('network');
    expect(loginErrorKey({ code: 'unexpected_failure', message: 'Database error saving new user', status: 500 })).toBeNull();
    expect(loginErrorKey(null)).toBeNull();
  });
});
