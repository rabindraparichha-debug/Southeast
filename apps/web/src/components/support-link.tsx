// "Help: WhatsApp the Tiffin team" (wave 4). Hidden when NEXT_PUBLIC_SUPPORT_WHATSAPP is not set.
// The number is the platform team's own (digits with country code, e.g. 919861000000).

const RAW = process.env.NEXT_PUBLIC_SUPPORT_WHATSAPP ?? '';

/** Digits for wa.me (a bare 10-digit Indian number gets 91), or null when no support number is set. */
export function supportNumber(raw: string = RAW): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  return digits.length >= 11 && digits.length <= 15 ? digits : null;
}

export function supportUrl(text?: string, raw: string = RAW): string | null {
  const n = supportNumber(raw);
  if (!n) return null;
  return `https://wa.me/${n}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

export function SupportLink({ text, label = 'Help: WhatsApp the Tiffin team', className }: { text?: string; label?: string; className?: string }) {
  const url = supportUrl(text);
  if (!url) return null;
  return (
    <a href={url} target="_blank" rel="noreferrer" className={className ?? 'text-sm text-brand-700 hover:underline'}>
      {label}
    </a>
  );
}
