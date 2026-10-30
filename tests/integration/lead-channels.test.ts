// Unit tests for lead channels (no network): Sulekha / Justdial enquiry emails, the Google Ads
// click id, and offline conversion uploads to Google Ads.
import { describe, expect, it } from 'vitest';
import { detectEmailSource, parseGoogleAdsLead, parseLeadEmail } from '../../supabase/functions/_shared/leads.ts';
import { adsDateTime, buildUpload, failedIndexes, loadAdsConfig, uploadConversions, type AdsConfig } from '../../supabase/functions/_shared/google-ads.ts';

describe('lead emails', () => {
  it('reads a Sulekha enquiry email', () => {
    const lead = parseLeadEmail({
      from: 'Sulekha <leads@sulekha.com>',
      subject: 'New enquiry for Tiffin Services in Bhubaneswar',
      text: 'Dear Partner,\n\nYou have received a new enquiry.\n\nCustomer Name: Priya Mishra\nMobile: +91 98610 00981\nLocation: Patia, Bhubaneswar\nRequirement: Veg lunch tiffin, 6 days a week\n\nRegards, Sulekha',
      messageId: '<abc123@sulekha.com>',
    });
    expect(lead).toMatchObject({
      source: 'sulekha', external_id: '<abc123@sulekha.com>', name: 'Priya Mishra', phone: '9861000981',
      area: 'Patia, Bhubaneswar', campaign: 'sk-email', whatsapp_opt_in: false,
    });
    expect(lead!.extra).toMatchObject({ slots: ['lunch'], diet: 'veg' });
  });

  it('reads a Justdial enquiry email with the value on the next line', () => {
    const lead = parseLeadEmail({
      from: 'noreply@justdial.com',
      subject: 'Enquiry for Tiffin Service',
      text: 'Caller Name:\nRakesh Behera\nCaller Number:\n9861000982\nArea: Saheed Nagar\nSearched For: Non veg dinner tiffin',
    });
    expect(lead).toMatchObject({ source: 'justdial', name: 'Rakesh Behera', phone: '9861000982', area: 'Saheed Nagar', campaign: 'jd-email' });
    expect(lead!.extra).toMatchObject({ slots: ['dinner'], diet: 'nonveg' });
    expect(lead!.external_id).toMatch(/^email:9861000982:/);
  });

  it('ignores emails without a phone number, and knows the senders', () => {
    expect(parseLeadEmail({ from: 'news@sulekha.com', subject: 'Grow your business', text: 'Upgrade to premium today!' })).toBeNull();
    expect(detectEmailSource('alerts@Sulekha.com')).toBe('sulekha');
    expect(detectEmailSource('x@justdial.com')).toBe('justdial');
    expect(detectEmailSource('someone@gmail.com')).toBe('other');
  });
});

describe('Google Ads', () => {
  it('keeps the click id from the lead form webhook', () => {
    expect(parseGoogleAdsLead({ lead_id: 'L1', gcl_id: 'EAIaIQ-test', user_column_data: [] }).gclid).toBe('EAIaIQ-test');
  });

  const cfg: AdsConfig = {
    mode: 'mock', customerId: '1234567890', developerToken: '', clientId: '', clientSecret: '', refreshToken: '', apiVersion: 'v21',
    actions: { trial: '111', plan: '222' },
  };
  const rows = [
    { id: 'a', gclid: 'g1', stage: 'trial' as const, value_paise: 14000, occurred_at: '2026-11-02T06:30:00Z' },
    { id: 'b', gclid: 'g2', stage: 'plan' as const, value_paise: 168000, occurred_at: '2026-11-04T06:30:00Z' },
    { id: 'c', gclid: 'g3', stage: 'renewal' as const, value_paise: 168000, occurred_at: '2026-12-04T06:30:00Z' },
  ];

  it('builds an upload in IST with values in rupees, skipping stages without a conversion action', () => {
    expect(adsDateTime('2026-11-02T06:30:00Z')).toBe('2026-11-02 12:00:00+05:30');
    const { body, skipped } = buildUpload(cfg, rows);
    expect(body.partialFailure).toBe(true);
    expect(body.conversions[0]).toEqual({ gclid: 'g1', conversionAction: 'customers/1234567890/conversionActions/111',
      conversionDateTime: '2026-11-02 12:00:00+05:30', conversionValue: 140, currencyCode: 'INR' });
    expect(skipped.map((r) => r.id)).toEqual(['c']);
  });

  it('mock mode accepts without calling Google; live mode reads partial failures', async () => {
    const mock = await uploadConversions(cfg, rows, (async () => { throw new Error('no network in mock mode'); }) as unknown as typeof fetch);
    expect(mock.filter((r) => r.ok).map((r) => r.id)).toEqual(['a', 'b']);
    expect(mock.find((r) => r.id === 'c')).toMatchObject({ skip: true });

    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      calls.push(url);
      if (url.includes('oauth2')) return new Response(JSON.stringify({ access_token: 't' }));
      return new Response(JSON.stringify({ partialFailureError: { details: [{ errors: [{ message: 'click too old',
        location: { fieldPathElements: [{ fieldName: 'conversions', index: 1 }] } }] }] } }));
    }) as unknown as typeof fetch;
    const live = await uploadConversions({ ...cfg, mode: 'live', developerToken: 'dev' }, rows, fetchFn);
    expect(calls[1]).toBe('https://googleads.googleapis.com/v21/customers/1234567890:uploadClickConversions');
    expect(live.find((r) => r.id === 'a')).toMatchObject({ ok: true });
    expect(live.find((r) => r.id === 'b')).toMatchObject({ ok: false, error: 'click too old' });
    expect(failedIndexes({})).toEqual(new Map());
  });

  it('stays in mock mode unless explicitly live with a developer token', () => {
    expect(loadAdsConfig((k) => ({ GOOGLE_ADS_MODE: 'live' } as Record<string, string>)[k]).mode).toBe('mock');
    expect(loadAdsConfig((k) => ({ GOOGLE_ADS_MODE: 'live', GOOGLE_ADS_DEVELOPER_TOKEN: 'x', GOOGLE_ADS_CUSTOMER_ID: '123-456-7890' } as Record<string, string>)[k]))
      .toMatchObject({ mode: 'live', customerId: '1234567890' });
  });
});
