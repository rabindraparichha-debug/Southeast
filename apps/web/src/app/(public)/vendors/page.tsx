import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { requireFlag } from '@/lib/flags';
import { firstParam, webSource } from '@/lib/public';
import { VendorForm } from './vendor-form';

export const metadata: Metadata = {
  title: 'Free software for your tiffin service · Tiffin Bhubaneswar',
  description: 'Daily counts, customer list and khata, a rider app, stock and printing. Free for tiffin kitchens in Bhubaneswar.',
};

const FEATURES = [
  { icon: '📋', title: 'Daily counts, done for you', text: 'Lunch and dinner counts lock at your cutoff, with the kitchen sheet and packing list ready.' },
  { icon: '📒', title: 'Customers and skips in one place', text: 'Note skips, pauses and address changes when customers call. Bring your list in from Excel.' },
  { icon: '💰', title: 'Payments and khata', text: 'Record cash, UPI and bank payments. See who owes what and print receipts.' },
  { icon: '🛵', title: 'Rider app', text: 'Your rider gets the day’s stops in order, works without network, and tracks tiffin boxes.' },
  { icon: '📦', title: 'Stock', text: 'Purchases, supplier dues and what you need for tomorrow’s count.' },
  { icon: '🆓', title: 'Free', text: 'No subscription fee and no commission on your customers.' },
];

export default async function VendorsPage({ searchParams }: PageProps<'/vendors'>) {
  await requireFlag('growth'); // vendor sign-up opens with the growth phase (D-180)
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: areas } = await supabase.rpc('list_areas');
  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_380px]">
      <section>
        <p className="text-sm font-medium text-brand-700">For tiffin and mess owners in Bhubaneswar</p>
        <h1 className="mt-1 text-3xl font-semibold leading-tight text-ink-900">Free software for your tiffin service</h1>
        <p className="mt-2 text-ink-700">
          Daily counts, customer list and khata, rider app, stock and printing. Your customers need no app.
        </p>
        <ul className="mt-6 grid gap-4 sm:grid-cols-2">
          {FEATURES.map((f) => (
            <li key={f.title} className="rounded-2xl bg-white p-4 ring-1 ring-ink-100">
              <div className="text-2xl" aria-hidden>{f.icon}</div>
              <h2 className="mt-1 font-semibold text-ink-900">{f.title}</h2>
              <p className="mt-0.5 text-sm text-ink-500">{f.text}</p>
            </li>
          ))}
        </ul>
        <p className="mt-6 text-sm text-ink-500">
          You need an FSSAI registration (basic registration is enough for a home kitchen). We help you set up.
        </p>
      </section>
      <VendorForm areas={Array.isArray(areas) ? (areas as string[]) : []} source={webSource(sp.src)} campaign={firstParam(sp.c) ?? null}
        turnstileSiteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? null} />
    </div>
  );
}
