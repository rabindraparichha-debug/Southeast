import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { firstParam, webSource } from '@/lib/public';
import { VendorForm } from './vendor-form';

export const metadata: Metadata = {
  title: 'Free software for your tiffin service · Tiffin Bhubaneswar',
  description: 'Daily counts, pause/skip on WhatsApp, payments to your own account, a rider app and new customers. Free for tiffin kitchens in Bhubaneswar.',
};

const FEATURES = [
  { icon: '📋', title: 'Daily counts, done for you', text: 'Lunch and dinner counts lock at your cutoff. No more WhatsApp scrolling at 10 pm.' },
  { icon: '💬', title: 'Pause and skip on WhatsApp', text: 'Customers pause, skip and see their balance themselves. You get the final list.' },
  { icon: '💰', title: 'Payments to your own account', text: 'UPI and card payments go straight to your bank through Razorpay. We never hold your money.' },
  { icon: '🛵', title: 'Rider app', text: 'Your rider gets the day’s stops in order, with tiffin box tracking.' },
  { icon: '🙋', title: 'New customers from us', text: 'People near you who want a tiffin are sent to kitchens with space, ranked by real reviews.' },
  { icon: '🆓', title: 'Free', text: 'No subscription fee and no commission on your existing customers.' },
];

export default async function VendorsPage({ searchParams }: PageProps<'/vendors'>) {
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: areas } = await supabase.rpc('list_areas');
  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_380px]">
      <section>
        <p className="text-sm font-medium text-brand-700">For tiffin and mess owners in Bhubaneswar</p>
        <h1 className="mt-1 text-3xl font-semibold leading-tight text-ink-900">Free software for your tiffin service</h1>
        <p className="mt-2 text-ink-700">
          Daily counts, pause/skip on WhatsApp, payments to your own account, rider app, new customers from us.
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
          To be listed for new customers you need an FSSAI registration (basic registration is enough for a home kitchen). We help you with the rest.
        </p>
      </section>
      <VendorForm areas={Array.isArray(areas) ? (areas as string[]) : []} source={webSource(sp.src)} campaign={firstParam(sp.c) ?? null} />
    </div>
  );
}
