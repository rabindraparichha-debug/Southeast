import type { Metadata } from 'next';
import Link from 'next/link';
import { formatPaise } from '@tiffin/core';
import { createClient } from '@/lib/supabase/server';
import { firstParam, photoUrl, ratingLabel, type DirectoryKitchen } from '@/lib/public';

export const metadata: Metadata = {
  title: 'Tiffin kitchens in Bhubaneswar · Tiffin Bhubaneswar',
  description: 'FSSAI-registered home kitchens and tiffin services in Bhubaneswar, with plans, prices and verified reviews.',
};

export default async function KitchensPage({ searchParams }: PageProps<'/kitchens'>) {
  const area = firstParam((await searchParams).area);
  const supabase = await createClient();
  const [{ data: list }, { data: areas }] = await Promise.all([
    supabase.rpc('kitchen_directory', { p_area: area }),
    supabase.rpc('list_areas'),
  ]);
  const kitchens = (Array.isArray(list) ? list : []) as unknown as DirectoryKitchen[];
  const areaNames = (Array.isArray(areas) ? areas : []) as string[];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold text-ink-900">Tiffin kitchens in Bhubaneswar</h1>
        <p className="mt-1 text-sm text-ink-500">Every kitchen here is FSSAI registered. Reviews come only from customers who received meals.</p>
      </div>
      <form className="flex flex-wrap items-end gap-2" action="/kitchens">
        <label className="block min-w-48 flex-1 space-y-1 sm:flex-none">
          <span className="text-sm font-medium text-ink-700">Delivers to</span>
          <select name="area" defaultValue={area ?? ''} className="block w-full rounded-lg border-0 px-3 py-2 text-sm ring-1 ring-ink-200">
            <option value="">All areas</option>
            {areaNames.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <button className="rounded-lg bg-white px-4 py-2 text-sm font-medium ring-1 ring-ink-200 hover:bg-ink-50">Show</button>
      </form>

      {kitchens.length ? (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {kitchens.map((k) => (
            <li key={k.slug}>
              <Link href={`/k/${k.slug}`} className="block overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-ink-100 hover:ring-brand-300">
                {k.photo ? (
                  // eslint-disable-next-line @next/next/no-img-element -- public bucket images
                  <img src={photoUrl(k.photo)} alt="" loading="lazy" className="h-36 w-full object-cover" />
                ) : (
                  <div className="flex h-36 items-center justify-center bg-brand-50 text-5xl" aria-hidden>🍱</div>
                )}
                <div className="p-4">
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="font-semibold text-ink-900">{k.name}</h2>
                    {k.from_price_paise != null && <span className="shrink-0 text-sm text-ink-700">from {formatPaise(k.from_price_paise)}</span>}
                  </div>
                  <p className="text-sm text-ink-500">
                    {[k.area, k.distance_km != null ? `${k.distance_km} km` : null, ratingLabel(k.rating, k.reviews)].filter(Boolean).join(' · ')}
                  </p>
                  {k.cuisine_tags?.length > 0 && <p className="mt-1 truncate text-xs text-ink-500">{k.cuisine_tags.join(' · ')}</p>}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="rounded-2xl bg-white p-6 text-center text-sm text-ink-700 ring-1 ring-ink-100">
          <p>No listed kitchen delivers to {area ?? 'this area'} yet.</p>
          <Link href={`/find${area ? `?area=${encodeURIComponent(area)}` : ''}`} className="mt-2 inline-block font-medium text-brand-700 underline">
            Leave your details and we’ll WhatsApp you when one does
          </Link>
        </div>
      )}

      <p className="text-sm text-ink-700">
        Not sure which to pick? <Link href="/find" className="font-medium text-brand-700 underline">Tell us what you need</Link> and we’ll show you the 2–3 best kitchens with space near you.
      </p>
    </div>
  );
}
