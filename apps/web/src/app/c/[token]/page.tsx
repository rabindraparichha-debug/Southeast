import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { PortalClient, type Portal } from './portal-client';

export const metadata: Metadata = { title: 'My tiffin', robots: { index: false, follow: false } };

// Customer page opened from the WhatsApp magic link. No login: every RPC checks the token.
export default async function CustomerPortal({ params }: PageProps<'/c/[token]'>) {
  const { token } = await params;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('portal_get', { p_token: token });
  if (error || !data) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md items-center px-6 text-center">
        <div>
          <div className="text-4xl">🔗</div>
          <h1 className="mt-2 text-lg font-semibold">This link has expired</h1>
          <p className="mt-1 text-sm text-ink-500">Send “my page” to your kitchen on WhatsApp to get a new one.</p>
        </div>
      </main>
    );
  }
  return <PortalClient token={token} initial={data as unknown as Portal} grievance={process.env.NEXT_PUBLIC_GRIEVANCE_CONTACT ?? ''} />;
}
