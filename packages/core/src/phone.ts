// Indian mobile numbers only (v1). Keep in sync with private.normalize_phone()
// in supabase/migrations/20261027000100_foundation.sql.

/** Normalises any common way of writing an Indian mobile number to +91XXXXXXXXXX, or null. */
export function normalizePhone(input: string | number | null | undefined): string | null {
  let digits = String(input ?? '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
}

/** "+919861000001" -> "+91 98610 00001" */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return '';
  const m = /^\+91(\d{5})(\d{5})$/.exec(e164);
  return m ? `+91 ${m[1]} ${m[2]}` : e164;
}

/** Supabase Auth stores phones without the leading +. */
export function toAuthPhone(e164: string): string {
  return e164.replace(/^\+/, '');
}
