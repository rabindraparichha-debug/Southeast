// Held-back vendor-first items over the API and in shared code: the customer import in chunks (status,
// second plan, repeated rows, diet warning, a retried chunk), billing-aware message templates, and the
// per-row outbox key sent to Meta. The import runs in a new kitchen of the spare login +919000000170,
// so the other suites' counts are untouched.
import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { importChunks, istDate, previewImportRows, type ImportRow } from '@tiffin/core';
import type { ImportResult } from '@tiffin/db';
import { renderOutbox, TEMPLATES } from '../../supabase/functions/_shared/templates.ts';
import { parseWebhook, toGraphPayload } from '../../supabase/functions/_shared/whatsapp.ts';
import { hmacSha256Hex } from '../../supabase/functions/_shared/razorpay.ts';
import { handleWhatsAppWebhook, isOutboxProof } from '../../supabase/functions/whatsapp-webhook/handler.ts';
import { loginAs, type Client } from './helpers';

const run = String(Date.now()).slice(-6);

describe('Held-back: customer import in chunks', () => {
  let owner: { client: Client; accessToken: string; userId: string };
  let kitchenId: string;
  const plans = [{ name: 'Lunch', diet: 'veg' }, { name: 'Dinner', diet: 'nonveg' }];

  beforeAll(async () => {
    owner = await loginAs('+919000000170');
    const { data: kitchen, error } = await owner.client.rpc('create_kitchen', { p_name: `Held Import IT ${run}`, p_area: 'Patia' });
    expect(error).toBeNull();
    kitchenId = (kitchen as { id: string }).id;
    for (const p of plans) {
      const res = await owner.client.from('plans').insert({
        kitchen_id: kitchenId, name: p.name, slots: [p.name === 'Lunch' ? 'lunch' : 'dinner'], diet: p.diet as 'veg' | 'nonveg',
        days_of_week: [1, 2, 3, 4, 5, 6, 7], price_per_meal_paise: p.name === 'Lunch' ? 6000 : 4000,
      });
      expect(res.error).toBeNull();
    }
  });

  it('saves a 245-row register in 100-row chunks, merging a repeated customer; a retried chunk changes nothing', async () => {
    const rows: ImportRow[] = Array.from({ length: 240 }, (_, i) => ({
      name: `Bulk ${i + 1}`, phone: `93170${String(i + 1).padStart(5, '0')}`, plan: 'Lunch', area: 'Patia',
      ...(i % 10 === 0 ? { status: 'Paused' } : {}),
    }));
    rows.push({ name: 'bulk 1', phone: '93170 00001', plan: 'Dinner' }); // 241: adds dinner to row 1
    rows.push({ name: 'Two Plans', phone: '9317099999', plan: 'Lunch', plan_2: 'Dinner', diet: 'Veg' }); // 242
    rows.push({ name: 'Left Us', phone: '9317099998', status: 'Stopped', dues: '300' }); // 243
    rows.push({ name: 'Diet Mix', phone: '9317099997', diet: 'Non-veg', plan: 'Lunch' }); // 244
    rows.push({ name: 'Bad Status', phone: '9317099996', status: 'maybe' }); // 245

    const preview = previewImportRows(rows, plans);
    expect(preview.issues).toEqual([{ row: 245, errors: ['invalid_status'] }]);
    expect(preview.warnings.map((w) => [w.row, w.warnings.join(',')])).toEqual([
      [241, 'adds_plan'], [242, 'diet_differs_from_plan'], [244, 'diet_differs_from_plan'],
    ]);

    const batch = randomUUID();
    const call = (chunk: { firstRow: number; rows: ImportRow[] }) => owner.client.rpc('import_customers', {
      p_kitchen: kitchenId, p_rows: chunk.rows, p_consent: true, p_file_name: 'register.xlsx',
      p_batch: batch, p_first_row: chunk.firstRow, p_total: rows.length,
    });
    const chunks = importChunks(rows);
    expect(chunks.map((c) => c.firstRow)).toEqual([1, 101, 201]);
    const results: ImportResult[] = [];
    for (const chunk of chunks) {
      const { data, error } = await call(chunk);
      expect(error).toBeNull();
      results.push(data as unknown as ImportResult);
    }
    const sum = (k: 'imported' | 'failed' | 'customers' | 'merged') => results.reduce((n, r) => n + (r[k] ?? 0), 0);
    expect([sum('imported'), sum('failed'), sum('customers'), sum('merged')]).toEqual([244, 1, 243, 1]);
    expect(results.flatMap((r) => r.errors)).toEqual([{ row: 245, errors: ['invalid_status'] }]);
    expect(results.flatMap((r) => r.warnings ?? []).map((w) => [w.row, w.warnings.join(',')]))
      .toEqual([[242, 'diet_differs_from_plan'], [244, 'diet_differs_from_plan']]);

    // The response to chunk 2 was "lost": the wizard sends it again with the same batch id.
    const again = await call(chunks[1]!);
    expect(again.error).toBeNull();
    // Nothing is created twice, and the retry reports what the lost response said (same totals).
    expect(again.data).toMatchObject({ already_done: 100, imported: 100, customers: 100, merged: 0 });
    // The last chunk again: its merge (row 241), its warnings and its error are reported as the first time.
    const third = await call(chunks[2]!);
    expect(third.error).toBeNull();
    const first3 = results[2]!;
    expect(third.data).toMatchObject({
      already_done: 45, imported: first3.imported, failed: first3.failed, customers: first3.customers, merged: 1,
      errors: first3.errors, warnings: first3.warnings,
    });

    const { count: customers } = await owner.client.from('customers').select('id', { count: 'exact', head: true }).eq('kitchen_id', kitchenId);
    expect(customers).toBe(243);
    const { data: subs } = await owner.client.from('subscriptions').select('customer_id, plan_id, status, start_date').eq('kitchen_id', kitchenId);
    expect(subs!.length).toBe(240 + 1 + 2 + 1); // bulk lunches, Bulk 1 dinner, Two Plans, Diet Mix
    expect(new Set(subs!.map((s) => s.start_date))).toEqual(new Set([istDate()])); // blank start date = today in IST
    expect(subs!.filter((s) => s.status === 'paused').length).toBe(24);

    const { data: bulk1 } = await owner.client.from('customers_v').select('id').eq('kitchen_id', kitchenId).eq('name', 'Bulk 1').single();
    expect(subs!.filter((s) => s.customer_id === bulk1!.id).map((s) => s.status).sort()).toEqual(['active', 'paused']);
    const { data: left } = await owner.client.from('customers_v').select('id').eq('kitchen_id', kitchenId).eq('name', 'Left Us').single();
    expect(subs!.some((s) => s.customer_id === left!.id)).toBe(false); // stopped: saved, no subscription

    const { data: batchRow } = await owner.client.from('import_batches').select('imported_rows, error_rows, total_rows').eq('id', batch).single();
    expect(batchRow).toEqual({ imported_rows: 244, error_rows: 1, total_rows: 245 });
  });
});

describe('Held-back: billing-aware templates and the outbox key', () => {
  it('every money template that goes to a payer has a payer variant', () => {
    for (const t of ['low_balance_reminder', 'dues_reminder', 'payment_receipt', 'refund_notice', 'refund_receipt',
      'payment_receipt_monthly', 'statement_ready']) {
      expect(TEMPLATES[t], t).toBeDefined();
      expect(TEMPLATES[`${t}_payer`], `${t}_payer`).toBeDefined();
    }
  });

  it('a monthly receipt says what is still to pay; the statement names the month', () => {
    expect(renderOutbox('payment_receipt_monthly', { amount_paise: 12000, due_paise: 30000 }, 'en', 'Maa Tarini', true))
      .toEqual({ type: 'text', text: 'Maa Tarini: payment of ₹120 received. Still to pay: ₹300. Thank you!' });
    expect(renderOutbox('statement_ready', { month: '2026-11', meals: 7, charged_paise: 42000, amount_due_paise: 30000 }, 'en', 'Maa Tarini', false))
      .toMatchObject({ type: 'template', name: 'statement_ready_v1', params: ['Maa Tarini', 'November 2026', '7', '₹420', '₹300'] });
    expect(renderOutbox('statement_ready_payer', { month: '2026-11', meals: 7, charged_paise: 42000, amount_due_paise: 30000,
      eater_name: 'Esha', url: 'https://x/c/t' }, 'or', 'K', false))
      .toMatchObject({ name: 'statement_ready_payer_v1', language: 'or', params: ['K', 'November 2026', 'Esha', '7', '₹420', '₹300', 'https://x/c/t'] });
  });

  it('the outbox row id travels to Meta and comes back on status webhooks', () => {
    expect(toGraphPayload('+919861000001', { type: 'text', text: 'hi' }, 'outbox:1234')).toMatchObject({ biz_opaque_callback_data: 'outbox:1234' });
    expect(toGraphPayload('+919861000001', { type: 'text', text: 'hi' })).not.toHaveProperty('biz_opaque_callback_data');
    const parsed = parseWebhook({ entry: [{ changes: [{ value: { statuses: [
      { id: 'wamid.a', status: 'sent', biz_opaque_callback_data: 'outbox:abc' }, { id: 'wamid.b', status: 'read' },
    ] } }] }] });
    expect(parsed.statuses).toEqual([{ id: 'wamid.a', status: 'sent', callbackData: 'outbox:abc' }, { id: 'wamid.b', status: 'read' }]);
  });
});

describe('Held-back: a status that proves a send is never dropped', () => {
  const cfg = { mode: 'mock' as const, appSecret: 'app', verifyToken: 'v', graphVersion: 'v21.0', publicWebUrl: 'https://x' };
  const post = async (statuses: Record<string, string>[], failStatus: boolean) => {
    const body = JSON.stringify({ entry: [{ changes: [{ value: { statuses } }] }] });
    const calls: string[] = [];
    const res = await handleWhatsAppWebhook(
      new Request('https://f/whatsapp-webhook', {
        method: 'POST', body, headers: { 'x-hub-signature-256': `sha256=${await hmacSha256Hex('app', body)}` },
      }),
      {
        cfg,
        rpc: async <T>(fn: string): Promise<T> => {
          calls.push(fn);
          if (failStatus && fn === 'wa_message_status') throw new Error('db_unavailable');
          return null as T;
        },
        send: async () => ({ id: 'x' }),
        createLink: async () => '',
      },
    );
    return { status: res.status, calls };
  };

  it('answers 503 (Meta retries) when an outbox proof could not be recorded, 200 otherwise', async () => {
    expect(isOutboxProof({ status: 'sent', callbackData: 'outbox:abc' })).toBe(true);
    expect(isOutboxProof({ status: 'failed', callbackData: 'outbox:abc' })).toBe(false);
    expect(isOutboxProof({ status: 'read' })).toBe(false);
    expect((await post([{ id: 'wamid.p', status: 'sent', biz_opaque_callback_data: 'outbox:abc' }], true)).status).toBe(503);
    expect((await post([{ id: 'wamid.q', status: 'read' }], true)).status).toBe(200); // a plain status is not worth a retry
    expect(await post([{ id: 'wamid.r', status: 'sent', biz_opaque_callback_data: 'outbox:abc' }], false))
      .toEqual({ status: 200, calls: ['wa_message_status'] });
  });
});
