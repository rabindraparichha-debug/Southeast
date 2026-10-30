import type { Metadata } from 'next';
import Link from 'next/link';
import { formatPaise } from '@tiffin/core';
import { requireAdmin } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { istDateTime } from '@/lib/public';
import { Alert, Badge, Card, PageHeader } from '@/components/ui';

export const metadata: Metadata = { title: 'Ad conversions · Admin' };

type Conversion = {
  id: string; lead: string | null; campaign: string | null; stage: 'trial' | 'plan' | 'renewal'; value_paise: number;
  occurred_at: string; status: 'pending' | 'sending' | 'sent' | 'failed' | 'skipped'; attempts: number; last_error: string | null; sent_at: string | null;
};
const TONE = { pending: 'gray', sending: 'blue', sent: 'green', failed: 'red', skipped: 'amber' } as const;
const STAGE = { trial: 'Paid trial', plan: 'Plan', renewal: 'Renewal' } as const;

// Paying customers reported back to Google Ads (offline click conversions, docs/LEAD_SOURCES.md 1c).
export default async function ConversionsPage() {
  await requireAdmin();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('admin_ad_conversions', { p_limit: 200 });
  const rows = (Array.isArray(data) ? data : []) as unknown as Conversion[];
  return (
    <main className="mx-auto max-w-5xl p-4 md:p-8">
      <Link href="/admin/leads" className="text-sm text-brand-700 hover:underline">← Leads</Link>
      <PageHeader title="Ad conversions" subtitle="Google Ads clicks that became paying customers, uploaded every 15 minutes. Only the click id, time and value are sent." />
      {error && <Alert>{error.message}</Alert>}
      <Card className="overflow-x-auto p-0">
        <table className="min-w-full text-sm">
          <thead className="border-b border-ink-100 text-left text-xs uppercase text-ink-500">
            <tr>
              <th className="px-4 py-3">Lead</th><th className="px-4 py-3">Stage</th><th className="px-4 py-3">Value</th>
              <th className="px-4 py-3">When</th><th className="px-4 py-3">Upload</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.map((c) => (
              <tr key={c.id}>
                <td className="px-4 py-3">{c.lead || 'No name'}{c.campaign && <div className="text-xs text-ink-500">{c.campaign}</div>}</td>
                <td className="px-4 py-3">{STAGE[c.stage]}</td>
                <td className="px-4 py-3">{formatPaise(c.value_paise)}</td>
                <td className="px-4 py-3 whitespace-nowrap text-ink-500">{istDateTime(c.occurred_at)}</td>
                <td className="px-4 py-3">
                  <Badge tone={TONE[c.status]}>{c.status}</Badge>
                  {c.last_error && <div className="text-xs text-ink-500">{c.last_error}</div>}
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={5} className="px-4 py-8 text-center text-ink-500">Nothing yet. Conversions appear when a lead with a Google click id pays.</td></tr>}
          </tbody>
        </table>
      </Card>
    </main>
  );
}
