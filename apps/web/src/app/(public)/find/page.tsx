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
  return (
    <FindClient
      areas={Array.isArray(areas) ? (areas as string[]) : []}
      source={webSource(sp.src)}
      campaign={firstParam(sp.c) ?? null}
      initialArea={firstParam(sp.area) ?? ''}
      kitchenSlug={firstParam(sp.kitchen) ?? null}
    />
  );
}
