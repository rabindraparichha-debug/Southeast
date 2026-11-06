import type { Metadata } from 'next';
import { requireFlag } from '@/lib/flags';
import { ConfirmClient } from './confirm-client';

export const metadata: Metadata = { title: 'Confirm your trial · Tiffin Bhubaneswar', robots: { index: false, follow: false } };

// Opened from the lead_confirm WhatsApp message (D-183): only whoever holds the phone gets here, so
// only they learn whether the number is already the kitchen's customer.
export default async function ConfirmPage({ params }: PageProps<'/find/confirm/[token]'>) {
  await requireFlag('marketplace');
  const { token } = await params;
  return <ConfirmClient token={token} />;
}
