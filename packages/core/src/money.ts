// Money is always integer paise. Never use floats for stored amounts.

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 0 });

/** 7050 -> "₹70.50", 7000 -> "₹70" */
export function formatPaise(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const rest = abs % 100;
  return `${sign}₹${inr.format(rupees)}${rest ? '.' + String(rest).padStart(2, '0') : ''}`;
}

/** "70", "70.5", "₹1,200.50" -> paise; null if not a valid non-negative amount. */
export function rupeesToPaise(input: string | number): number | null {
  const s = String(input).replace(/[₹,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}
