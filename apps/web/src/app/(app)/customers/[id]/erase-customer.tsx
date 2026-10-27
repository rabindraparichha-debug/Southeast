'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Alert, Button, Card } from '@/components/ui';

export function EraseCustomer({ customerId }: { customerId: string }) {
  const router = useRouter();
  const [error, setError] = useState('');

  async function erase() {
    if (!confirm('Delete this customer’s personal data? Their name, phone and address are removed permanently. Payment records are kept.')) return;
    const { error } = await supabaseBrowser().rpc('erase_customer', { p_customer: customerId });
    if (error) return setError(friendlyError(error));
    router.push('/customers');
    router.refresh();
  }

  return (
    <Card title="Delete customer data" className="lg:col-span-2">
      <p className="mb-3 text-sm text-ink-600">Use this when a customer asks for their data to be deleted.</p>
      <Button variant="danger" onClick={erase}>Delete personal data</Button>
      <div className="mt-2"><Alert>{error}</Alert></div>
    </Card>
  );
}
