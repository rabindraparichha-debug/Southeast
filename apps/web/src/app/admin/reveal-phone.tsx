'use client';

import { useState } from 'react';
import { formatPhone } from '@tiffin/core';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';

// Shows the masked number; revealing calls a logged RPC (audit_log + lead event).
export function RevealPhone({ kind, id, masked }: { kind: 'lead' | 'vendor'; id: string; masked: string }) {
  const [phone, setPhone] = useState<string | null>(null);
  const [error, setError] = useState('');
  async function reveal() {
    setError('');
    const supabase = supabaseBrowser();
    const { data, error } = kind === 'lead'
      ? await supabase.rpc('admin_reveal_lead_phone', { p_lead: id })
      : await supabase.rpc('admin_reveal_vendor_phone', { p_id: id });
    if (error) return setError(friendlyError(error));
    setPhone(data);
  }
  if (phone) {
    return (
      <span className="inline-flex items-center gap-2">
        <a href={`tel:${phone}`} className="font-medium text-brand-700 hover:underline">{formatPhone(phone)}</a>
        <a href={`https://wa.me/${phone.replace(/\D/g, '')}`} target="_blank" rel="noreferrer" className="text-xs text-ink-500 hover:underline">WhatsApp</a>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      <span className="font-mono text-ink-700">{masked}</span>
      <button type="button" onClick={reveal} className="text-xs text-brand-700 hover:underline" title="Logged in the audit log">Reveal</button>
      {error && <span className="text-xs text-red-700">{error}</span>}
    </span>
  );
}
