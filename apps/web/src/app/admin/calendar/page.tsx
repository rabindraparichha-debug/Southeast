import type { Metadata } from 'next';
import { istDate } from '@tiffin/core';
import { requireAdmin } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { Alert, PageHeader } from '@/components/ui';
import { CalendarEditor } from './calendar-editor';

export const metadata: Metadata = { title: 'Food calendar · Admin' };

// Odisha food calendar (P5): Kartika month and festivals. Veg-only festivals count as veg days for
// customers who observe them; every edit re-plans the kitchens that use veg days (D-095).
export default async function AdminCalendarPage({ searchParams }: PageProps<'/admin/calendar'>) {
  await requireAdmin();
  const sp = await searchParams;
  const showPast = sp.past === '1';
  const supabase = await createClient();
  let q = supabase.from('food_calendar').select('id, kind, name, starts_on, ends_on, veg_only, notes, updated_at').order('starts_on');
  if (!showPast) q = q.gte('ends_on', istDate());
  const { data, error } = await q;
  return (
    <main className="mx-auto max-w-6xl p-4 md:p-8">
      <PageHeader title="Admin · Food calendar" subtitle="Dates are approximate (Odia Purnimanta calendar). Correct them here; kitchens using veg days are re-planned at once." />
      {error && <Alert>{error.message}</Alert>}
      <CalendarEditor entries={data ?? []} showPast={showPast} />
    </main>
  );
}
