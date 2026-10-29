import type { Metadata } from 'next';
import Link from 'next/link';
import { requireAdmin } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { firstParam, istDateTime } from '@/lib/public';
import { Alert, Badge, PageHeader } from '@/components/ui';
import type { AdminReview } from '../types';
import { HideButton } from './hide-button';

export const metadata: Metadata = { title: 'Reviews · Admin' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Review moderation: hidden reviews leave the public page and the kitchen's rating.
export default async function AdminReviewsPage({ searchParams }: PageProps<'/admin/reviews'>) {
  await requireAdmin();
  const sp = await searchParams;
  const k = firstParam(sp.kitchen);
  const kitchen = k && UUID.test(k) ? k : undefined;
  const supabase = await createClient();
  const [{ data, error }, { data: kitchens }] = await Promise.all([
    supabase.rpc('admin_reviews', { p_kitchen: kitchen, p_limit: 200 }),
    supabase.from('kitchens').select('id, name').order('name'),
  ]);
  const reviews = (data ?? []) as unknown as AdminReview[];
  const hidden = reviews.filter((r) => r.hidden).length;
  const input = 'rounded-lg border-0 px-3 py-2 text-sm ring-1 ring-ink-200';

  return (
    <main className="mx-auto max-w-4xl p-4 md:p-8">
      <PageHeader title="Reviews" subtitle={`${reviews.length} latest reviews · ${hidden} hidden. Hide abusive, fake or personal content; don’t hide honest criticism.`} />
      <form action="/admin/reviews" className="mb-4 flex flex-wrap items-end gap-2">
        <label className="space-y-1 text-sm">
          <span className="block text-ink-700">Kitchen</span>
          <select name="kitchen" defaultValue={kitchen ?? ''} className={input}>
            <option value="">All kitchens</option>
            {(kitchens ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>
        <button className="rounded-lg bg-white px-4 py-2 text-sm font-medium ring-1 ring-ink-200 hover:bg-ink-50">Show</button>
      </form>
      {error && <Alert>{error.message}</Alert>}
      <ul className="space-y-3">
        {reviews.map((r) => (
          <li key={r.id} className={`flex items-start justify-between gap-4 rounded-xl bg-white p-4 shadow-sm ring-1 ring-ink-100 ${r.hidden ? 'opacity-70' : ''}`}>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-amber-500" aria-label={`${r.rating} out of 5 stars`}>{'★'.repeat(r.rating)}<span className="text-ink-200">{'★'.repeat(5 - r.rating)}</span></span>
                <Link href={`/k/${r.kitchen_slug}`} target="_blank" className="font-medium text-ink-900 hover:underline">{r.kitchen}</Link>
                {r.verified ? <Badge tone="green">Verified customer</Badge> : <Badge>Unverified</Badge>}
                {r.hidden && <Badge tone="red">Hidden</Badge>}
              </div>
              {r.comment ? <p className="mt-1 whitespace-pre-line text-sm text-ink-800">{r.comment}</p> : <p className="mt-1 text-sm italic text-ink-400">No comment</p>}
              <p className="mt-1 text-xs text-ink-500">{r.customer ?? 'Customer'} · {istDateTime(r.created_at)}</p>
            </div>
            <HideButton reviewId={r.id} hidden={r.hidden} />
          </li>
        ))}
        {!reviews.length && !error && <li className="text-sm text-ink-500">No reviews yet.</li>}
      </ul>
    </main>
  );
}
