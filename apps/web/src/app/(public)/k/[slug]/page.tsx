import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { formatPaise, formatServiceDate, isoDow, WEEKDAYS } from '@tiffin/core';
import { createClient } from '@/lib/supabase/server';
import { photoUrl, ratingLabel, type KitchenProfile } from '@/lib/public';
import { DIET_LABEL } from '@/components/ui';

const getProfile = cache(async (slug: string): Promise<KitchenProfile | null> => {
  const supabase = await createClient();
  const { data } = await supabase.rpc('kitchen_profile', { p_slug: slug });
  return (data as unknown as KitchenProfile | null) ?? null;
});

export async function generateMetadata({ params }: PageProps<'/k/[slug]'>): Promise<Metadata> {
  const { slug } = await params;
  const k = await getProfile(slug);
  if (!k) return { title: 'Kitchen not found · Tiffin Bhubaneswar' };
  return {
    title: `${k.name}${k.area ? `, ${k.area}` : ''} · Tiffin Bhubaneswar`,
    description: k.description?.slice(0, 160) ?? `Home-style tiffin service in ${k.area ?? 'Bhubaneswar'}. FSSAI registered.`,
  };
}

const SLOT = { lunch: 'Lunch', dinner: 'Dinner' } as const;
function days(iso: number[]) {
  if (iso.length === 7) return 'Every day';
  const on = WEEKDAYS.filter((d) => iso.includes(d.iso));
  const contiguous = on.length > 2 && on.every((d, i) => i === 0 || d.iso === on[i - 1]!.iso + 1);
  return contiguous ? `${on[0]!.short}–${on[on.length - 1]!.short}` : on.map((d) => d.short).join(', ');
}

// Public kitchen page (active kitchens only).
export default async function KitchenPage({ params }: PageProps<'/k/[slug]'>) {
  const { slug } = await params;
  const k = await getProfile(slug);
  if (!k) notFound();
  const offDays = WEEKDAYS.filter((d) => (k.weekly_off ?? []).includes(d.iso)).map((d) => d.long);
  const menu = k.menu.filter((m) => m.dishes?.length && !(k.weekly_off ?? []).includes(isoDow(m.date)));
  const cta = `/find?kitchen=${encodeURIComponent(k.slug)}${k.area ? `&area=${encodeURIComponent(k.area)}` : ''}`;

  return (
    <article className="mx-auto max-w-3xl space-y-6">
      {k.photo_paths.length ? (
        <div className="-mx-4 flex snap-x snap-mandatory gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          {k.photo_paths.map((p, i) => (
            // eslint-disable-next-line @next/next/no-img-element -- public bucket images, sizes vary
            <img key={p} src={photoUrl(p)} alt={`${k.name} photo ${i + 1}`} loading={i === 0 ? 'eager' : 'lazy'}
              className="h-56 w-[85%] shrink-0 snap-center rounded-2xl object-cover sm:h-64 sm:w-[48%]" />
          ))}
        </div>
      ) : (
        <div className="flex h-40 items-center justify-center rounded-2xl bg-brand-50 text-6xl" aria-hidden>🍱</div>
      )}

      <header className="space-y-2">
        <h1 className="text-2xl font-semibold text-ink-900">{k.name}</h1>
        <p className="text-sm text-ink-500">{[k.area, k.city].filter(Boolean).join(', ')} · {ratingLabel(k.rating?.avg, k.rating?.reviews)}</p>
        <p className="inline-flex items-center gap-2 rounded-lg bg-green-50 px-3 py-1.5 text-sm font-medium text-green-800 ring-1 ring-green-200">
          ✓ FSSAI Reg. No. {k.fssai_no ?? 'pending'}
        </p>
        {k.cuisine_tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {k.cuisine_tags.map((t) => <span key={t} className="rounded-full bg-ink-100 px-2.5 py-0.5 text-xs text-ink-700">{t}</span>)}
          </div>
        )}
        {k.description && <p className="whitespace-pre-line text-ink-700">{k.description}</p>}
      </header>

      <div className="rounded-2xl bg-brand-50 p-4 ring-1 ring-brand-100">
        {k.accepting ? (
          <>
            <p className="text-sm text-ink-800">Try {k.trial_meals} meals first. Pay the kitchen directly; unused meals are refunded pro-rata.</p>
            <Link href={cta} className="mt-3 inline-flex w-full items-center justify-center rounded-lg bg-brand-600 px-4 py-3 font-medium text-white hover:bg-brand-700 sm:w-auto">
              Start a trial
            </Link>
          </>
        ) : (
          <>
            <p className="text-sm text-ink-800">This kitchen is full right now. Leave your details and we’ll find you another one nearby.</p>
            <Link href={cta} className="mt-3 inline-flex items-center justify-center rounded-lg bg-white px-4 py-2 text-sm font-medium text-ink-800 ring-1 ring-ink-200">
              Find a tiffin near me
            </Link>
          </>
        )}
      </div>

      <section>
        <h2 className="mb-2 text-lg font-semibold">Plans</h2>
        {k.plans.length ? (
          <ul className="divide-y divide-ink-100 rounded-2xl bg-white ring-1 ring-ink-100">
            {k.plans.map((p) => (
              <li key={p.id} className="flex items-start justify-between gap-3 p-4">
                <div>
                  <div className="font-medium">{p.name}</div>
                  <div className="text-sm text-ink-500">
                    {DIET_LABEL[p.diet]} · {p.slots.map((s) => SLOT[s]).join(' + ')} · {days(p.days_of_week)}
                  </div>
                  {p.description && <p className="mt-1 text-sm text-ink-700">{p.description}</p>}
                </div>
                <div className="shrink-0 text-right font-semibold">{formatPaise(p.price_per_meal_paise)}<span className="text-sm font-normal text-ink-500">/meal</span></div>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-ink-500">Plans coming soon.</p>}
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold">This week’s menu</h2>
        {menu.length ? (
          <ul className="space-y-1.5 rounded-2xl bg-white p-4 text-sm ring-1 ring-ink-100">
            {menu.map((m) => (
              <li key={`${m.date}-${m.slot}`}>
                <span className="text-ink-500">{formatServiceDate(m.date)} · {SLOT[m.slot]}:</span> {m.dishes.join(', ')}
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-ink-500">The kitchen hasn’t published this week’s menu yet.</p>}
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold">Reviews from customers</h2>
        <p className="mb-2 text-xs text-ink-500">Only customers who have received meals from this kitchen can review it.</p>
        {k.reviews.length ? (
          <ul className="space-y-2">
            {k.reviews.map((r, i) => (
              <li key={i} className="rounded-2xl bg-white p-4 text-sm ring-1 ring-ink-100">
                <div className="flex justify-between">
                  <span className="text-amber-600" aria-label={`${r.rating} out of 5`}>{'★'.repeat(r.rating)}<span className="text-ink-200">{'★'.repeat(5 - r.rating)}</span></span>
                  <span className="text-xs text-ink-500">{r.name} · {new Date(r.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                </div>
                {r.comment && <p className="mt-1 text-ink-700">{r.comment}</p>}
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-ink-500">No reviews yet. This kitchen is new on the platform.</p>}
      </section>

      <section className="text-sm text-ink-700">
        <h2 className="mb-2 text-lg font-semibold text-ink-900">Service area</h2>
        <p>Delivers within {Number(k.service_radius_km)} km of {k.area ?? 'the kitchen'}.</p>
        {offDays.length > 0 && <p>Closed on {offDays.join(', ')}.</p>}
      </section>
    </article>
  );
}
