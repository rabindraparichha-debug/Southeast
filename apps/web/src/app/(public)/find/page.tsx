import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { firstParam, webSource } from '@/lib/public';
import { FindClient } from './find-client';

export const metadata: Metadata = {
  title: 'Find a tiffin near you · Tiffin Bhubaneswar',
  description: 'Home-style lunch and dinner tiffins from FSSAI-registered kitchens near you in Bhubaneswar. Start with a small paid trial.',
};

// Lead form → shortlist of 2–3 nearby kitchens → pick one → pay the trial. No login.
export default async function FindPage({ searchParams }: PageProps<'/find'>) {
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: areas } = await supabase.rpc('list_areas');
  // Google Ads auto-tagging adds ?gclid=; it is attached to the lead so paid customers can be reported back.
  const rawGclid = Array.isArray(sp.gclid) ? sp.gclid[0] : sp.gclid;
  const gclid = rawGclid && /^[A-Za-z0-9_-]{10,200}$/.test(rawGclid) ? rawGclid : null;
  return (
    <FindClient
      areas={Array.isArray(areas) ? (areas as string[]) : []}
      source={gclid && !sp.src ? 'google_ads' : webSource(sp.src)}
      campaign={firstParam(sp.c) ?? null}
      initialArea={firstParam(sp.area) ?? ''}
      kitchenSlug={firstParam(sp.kitchen) ?? null}
      gclid={gclid}
    />
  );
}
