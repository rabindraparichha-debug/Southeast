// Opens the vendor's own WhatsApp with a prefilled message (platform WhatsApp arrives in M4).
export function whatsappUrl(phoneE164: string | null | undefined, text: string): string {
  const digits = (phoneE164 ?? '').replace(/\D/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
