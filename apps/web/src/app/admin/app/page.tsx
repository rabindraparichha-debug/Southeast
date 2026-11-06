import type { Metadata } from 'next';
import { requireAdmin } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { istDateTime } from '@/lib/public';
import { Alert, Badge, Card, PageHeader } from '@/components/ui';
import { MinVersionForm } from './min-version-form';

export const metadata: Metadata = { title: 'Mobile app · Admin' };

// Minimum mobile app version (audit item 26). Older builds send their saved rider actions first,
// then show "Update required" with the download link.
export default async function AdminAppPage() {
  await requireAdmin();
  const supabase = await createClient();
  const { data } = await supabase.from('platform_settings').select('enabled, value, updated_at').eq('key', 'min_app_version').maybeSingle();
  const value = (data?.value ?? {}) as { version?: string; android_url?: string; ios_url?: string; message?: string };
  const enabled = Boolean(data?.enabled && value.version);

  return (
    <main className="mx-auto max-w-3xl p-4 md:p-8">
      <PageHeader title="Admin · Mobile app" subtitle="Require a minimum app version when an old build can no longer work with the server." />
      <Card title="Minimum version">
        <Alert tone="amber">
          Raise this only after the new build is available at the download links. Phones on an older version can do nothing else
          until they update (their saved deliveries are sent first).
        </Alert>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <Badge tone={enabled ? 'amber' : 'gray'}>{enabled ? `Required: ${value.version}` : 'No minimum'}</Badge>
          {data?.updated_at && <span className="text-xs text-ink-500">Last changed {istDateTime(data.updated_at)}</span>}
        </div>
        <MinVersionForm initial={{ version: enabled ? value.version ?? '' : '', android_url: value.android_url ?? '', ios_url: value.ios_url ?? '', message: value.message ?? '' }} />
      </Card>
    </main>
  );
}
