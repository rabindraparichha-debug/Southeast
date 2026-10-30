import type { Metadata } from 'next';
import Link from 'next/link';
import { requireAdmin } from '@/lib/session';
import { PageHeader } from '@/components/ui';
import { ImportLeads } from './import-leads';

export const metadata: Metadata = { title: 'Import leads · Admin' };

// Directory dashboards without an API (Sulekha, Justdial exports): upload their CSV (docs/LEAD_SOURCES.md).
export default async function ImportLeadsPage() {
  await requireAdmin();
  return (
    <main className="mx-auto max-w-4xl p-4 md:p-8">
      <Link href="/admin/leads" className="text-sm text-brand-700 hover:underline">← Leads</Link>
      <PageHeader title="Import leads" subtitle="Upload a CSV exported from Sulekha, Justdial or another directory. Importing the same file twice creates nothing." />
      <ImportLeads />
    </main>
  );
}
