'use client';

import { useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { whatsappUrl } from '@/lib/whatsapp';
import { Alert, Badge, Button, Card } from '@/components/ui';

// Moves offline customers to WhatsApp step by step: invite them to the platform number (with the
// kitchen code so the bot routes them), or share their 7-day page link from the vendor's phone.
// Each part shows only when its phase is switched on (D-180): the invite needs customer_whatsapp,
// page links need customer_portal. Page links can be revoked at once (D-182).
export function WhatsAppCard({ customerId, customerName, customerPhone, kitchenName, kitchenSlug, optedIn, conversationId, whatsapp = true, portal = true }: {
  customerId: string; customerName: string; customerPhone: string | null; kitchenName: string; kitchenSlug: string; optedIn: boolean; conversationId: string | null;
  whatsapp?: boolean; portal?: boolean;
}) {
  const platform = (process.env.NEXT_PUBLIC_WHATSAPP_NUMBER ?? '').replace(/\D/g, '');
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const invite = whatsapp && platform ? `https://wa.me/${platform}?text=${encodeURIComponent(`Hi ${kitchenSlug}`)}` : '';

  async function pageLink(rotate = false) {
    setError('');
    setNote('');
    setBusy(true);
    const { data, error } = rotate
      ? await supabaseBrowser().rpc('rotate_customer_page_link', { p_customer: customerId })
      : await supabaseBrowser().rpc('customer_page_link', { p_customer: customerId });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    setLink(`${window.location.origin}/c/${data}`);
    if (rotate) setNote('Every older link for this customer has stopped working. Only the link below works now.');
  }

  async function revokeAll() {
    if (!window.confirm(`Stop every page link of ${customerName}? Links already sent stop working at once.`)) return;
    setError('');
    setBusy(true);
    const { data, error } = await supabaseBrowser().rpc('revoke_customer_page_links', { p_customer: customerId });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    setLink('');
    setNote(Number(data) > 0 ? `${data} link(s) stopped. Make a new one when the customer needs it.` : 'There was no working link.');
  }

  return (
    <Card title={whatsapp ? 'WhatsApp' : 'Customer page'}
      actions={whatsapp ? (optedIn ? <Badge tone="green">Gets updates</Badge> : <Badge>Not on WhatsApp updates</Badge>) : undefined}>
      <p className="text-sm text-ink-600">
        {whatsapp
          ? 'Customers can skip, pause, pay and see their balance themselves on WhatsApp or their page. You can still do everything for them here.'
          : 'Customers can skip, pause and see their balance themselves on their page. You can still do everything for them here.'}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {invite && (
          <a className="inline-flex items-center rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700" target="_blank" rel="noreferrer"
             href={whatsappUrl(customerPhone, `Namaskar ${customerName}! ${kitchenName} is now on WhatsApp: see the menu, skip a meal and pay here: ${invite}`)}>
            Invite to WhatsApp
          </a>
        )}
        {portal && <Button variant="secondary" onClick={() => pageLink(false)} disabled={busy}>Get page link</Button>}
        {portal && <Button variant="secondary" onClick={() => pageLink(true)} disabled={busy}>New link (stop old ones)</Button>}
        {portal && <Button variant="secondary" onClick={revokeAll} disabled={busy}>Stop all links</Button>}
        {whatsapp && conversationId && <a href={`/inbox?c=${conversationId}`} className="inline-flex items-center px-2 text-sm text-brand-700 hover:underline">Open chat</a>}
      </div>
      {note && <p className="mt-2 text-sm text-ink-700" role="status">{note}</p>}
      {link && (
        <div className="mt-3 space-y-2 text-sm">
          <input readOnly value={link} onFocus={(e) => e.target.select()} className="w-full rounded-lg px-3 py-2 ring-1 ring-ink-200" />
          <a className="text-green-700 hover:underline" target="_blank" rel="noreferrer"
             href={whatsappUrl(customerPhone, `Namaskar ${customerName}, your ${kitchenName} page (valid 7 days): ${link}`)}>Send this link on WhatsApp</a>
        </div>
      )}
      {whatsapp && !platform && <p className="mt-2 text-xs text-ink-500">Set NEXT_PUBLIC_WHATSAPP_NUMBER to enable invites.</p>}
      <div className="mt-2"><Alert>{error}</Alert></div>
    </Card>
  );
}
