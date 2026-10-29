'use client';

import { useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { whatsappUrl } from '@/lib/whatsapp';
import { Alert, Badge, Button, Card } from '@/components/ui';

// Moves offline customers to WhatsApp step by step: invite them to the platform number (with the
// kitchen code so the bot routes them), or share their 7-day page link from the vendor's phone.
export function WhatsAppCard({ customerId, customerName, customerPhone, kitchenName, kitchenSlug, optedIn, conversationId }: {
  customerId: string; customerName: string; customerPhone: string | null; kitchenName: string; kitchenSlug: string; optedIn: boolean; conversationId: string | null;
}) {
  const platform = (process.env.NEXT_PUBLIC_WHATSAPP_NUMBER ?? '').replace(/\D/g, '');
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const invite = platform ? `https://wa.me/${platform}?text=${encodeURIComponent(`Hi ${kitchenSlug}`)}` : '';

  async function pageLink() {
    const { data, error } = await supabaseBrowser().rpc('customer_page_link', { p_customer: customerId });
    if (error) return setError(friendlyError(error));
    setLink(`${window.location.origin}/c/${data}`);
  }

  return (
    <Card title="WhatsApp" actions={optedIn ? <Badge tone="green">Gets updates</Badge> : <Badge>Not on WhatsApp updates</Badge>}>
      <p className="text-sm text-ink-600">
        Customers can skip, pause, pay and see their balance themselves on WhatsApp or their page. You can still do everything for them here.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {invite && (
          <a className="inline-flex items-center rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700" target="_blank" rel="noreferrer"
             href={whatsappUrl(customerPhone, `Namaskar ${customerName}! ${kitchenName} is now on WhatsApp: see the menu, skip a meal and pay here: ${invite}`)}>
            Invite to WhatsApp
          </a>
        )}
        <Button variant="secondary" onClick={pageLink}>Get page link</Button>
        {conversationId && <a href={`/inbox?c=${conversationId}`} className="inline-flex items-center px-2 text-sm text-brand-700 hover:underline">Open chat</a>}
      </div>
      {link && (
        <div className="mt-3 space-y-2 text-sm">
          <input readOnly value={link} onFocus={(e) => e.target.select()} className="w-full rounded-lg px-3 py-2 ring-1 ring-ink-200" />
          <a className="text-green-700 hover:underline" target="_blank" rel="noreferrer"
             href={whatsappUrl(customerPhone, `Namaskar ${customerName}, your ${kitchenName} page (valid 7 days): ${link}`)}>Send this link on WhatsApp</a>
        </div>
      )}
      {!platform && <p className="mt-2 text-xs text-ink-500">Set NEXT_PUBLIC_WHATSAPP_NUMBER to enable invites.</p>}
      <div className="mt-2"><Alert>{error}</Alert></div>
    </Card>
  );
}
