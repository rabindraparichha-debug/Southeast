// Customer import: column mapping + preview validation. The server
// (public.import_customers) re-validates and is authoritative; error codes match.

import { normalizePhone } from './phone';

export const IMPORT_FIELDS = [
  { key: 'name', label: 'Name', required: true, aliases: ['name', 'customer', 'customer name', 'full name', 'naam'] },
  { key: 'phone', label: 'Phone', required: true, aliases: ['phone', 'mobile', 'mobile no', 'phone number', 'contact', 'whatsapp', 'number', 'mob'] },
  { key: 'diet', label: 'Diet', required: false, aliases: ['diet', 'veg/non-veg', 'veg nonveg', 'food type', 'type'] },
  { key: 'language', label: 'Language', required: false, aliases: ['language', 'lang', 'bhasha'] },
  { key: 'line1', label: 'Flat / house', required: false, aliases: ['address', 'flat', 'house', 'flat no', 'house no', 'address line 1'] },
  { key: 'area', label: 'Area', required: false, aliases: ['area', 'locality', 'colony', 'sector'] },
  { key: 'landmark', label: 'Landmark', required: false, aliases: ['landmark', 'near'] },
  { key: 'delivery_notes', label: 'Delivery notes', required: false, aliases: ['delivery notes', 'delivery instructions', 'instructions'] },
  { key: 'notes', label: 'Notes', required: false, aliases: ['notes', 'remarks', 'comment', 'comments'] },
  { key: 'plan', label: 'Plan', required: false, aliases: ['plan', 'plan name', 'package', 'subscription'] },
  { key: 'start_date', label: 'Start date', required: false, aliases: ['start date', 'start', 'from', 'joining date', 'date'] },
  { key: 'qty', label: 'Tiffins per meal', required: false, aliases: ['qty', 'quantity', 'tiffins', 'count'] },
  { key: 'lat', label: 'Latitude', required: false, aliases: ['lat', 'latitude'] },
  { key: 'lng', label: 'Longitude', required: false, aliases: ['lng', 'lon', 'long', 'longitude'] },
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number]['key'];
export type ImportRow = Partial<Record<ImportField, string>>;
export type ColumnMapping = Partial<Record<ImportField, number>>;

export type ImportErrorCode =
  | 'name_required'
  | 'invalid_phone'
  | 'duplicate_in_file'
  | 'already_exists'
  | 'invalid_diet'
  | 'invalid_language'
  | 'unknown_plan'
  | 'invalid_date'
  | 'start_date_requires_plan'
  | 'invalid_qty'
  | 'invalid_location';

export const IMPORT_ERROR_MESSAGES: Record<ImportErrorCode, string> = {
  name_required: 'Name is missing',
  invalid_phone: 'Phone is not a valid 10-digit Indian mobile number',
  duplicate_in_file: 'Same phone number appears earlier in this file',
  already_exists: 'A customer with this phone number already exists',
  invalid_diet: 'Diet must be Veg, Non-veg or Jain',
  invalid_language: 'Language must be English, Odia or Hindi',
  unknown_plan: 'No active plan with this name',
  invalid_date: 'Start date is not a valid date',
  start_date_requires_plan: 'Start date given without a plan',
  invalid_qty: 'Tiffins per meal must be a number from 1 to 20',
  invalid_location: 'Latitude and longitude must both be numbers',
};

/** Human message for a server or client error code (server may add `db_error:XXXXX`). */
export function importErrorMessage(code: string): string {
  return IMPORT_ERROR_MESSAGES[code as ImportErrorCode] ?? `Could not save this row (${code})`;
}

const clean = (s: unknown) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9/]+/g, ' ')
    .trim();

/** Guesses which spreadsheet column holds which field from the header row. */
export function guessMapping(headers: unknown[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const used = new Set<number>();
  const cleaned = headers.map(clean);
  // Exact alias matches first, then "contains" matches, so "Customer Name" beats "Name" collisions.
  for (const pass of ['exact', 'contains'] as const) {
    for (const field of IMPORT_FIELDS) {
      if (mapping[field.key] !== undefined) continue;
      const idx = cleaned.findIndex(
        (h, i) =>
          !used.has(i) &&
          h !== '' &&
          field.aliases.some((a) => (pass === 'exact' ? h === clean(a) : h.includes(clean(a)))),
      );
      if (idx >= 0) {
        mapping[field.key] = idx;
        used.add(idx);
      }
    }
  }
  return mapping;
}

/** Excel serial date (days since 1899-12-30) -> YYYY-MM-DD. */
function excelSerialToIso(serial: number): string {
  const ms = Math.round((serial - 25569) * 86_400_000);
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Normalises the common Indian date spellings to YYYY-MM-DD. Day comes first
 * (dd/mm/yyyy), as written in India. Unparseable input is returned as-is so the
 * server reports it as invalid_date.
 */
export function normalizeDate(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 10);
  }
  if (typeof value === 'number' && value > 20000 && value < 80000) return excelSerialToIso(value);
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const [, d, mo, y] = m as unknown as [string, string, string, string];
    const year = y.length === 2 ? `20${y}` : y;
    const iso = `${year}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
    const check = new Date(`${iso}T00:00:00Z`);
    if (!Number.isNaN(check.getTime()) && check.toISOString().slice(0, 10) === iso) return iso;
  }
  return s;
}

/** Turns spreadsheet rows (without the header row) into ImportRow objects. Blank rows are dropped. */
export function applyMapping(rows: unknown[][], mapping: ColumnMapping): ImportRow[] {
  const out: ImportRow[] = [];
  for (const row of rows) {
    if (!row || row.every((c) => String(c ?? '').trim() === '')) continue;
    const r: ImportRow = {};
    for (const field of IMPORT_FIELDS) {
      const idx = mapping[field.key];
      if (idx === undefined) continue;
      const raw = row[idx];
      const value = field.key === 'start_date' ? normalizeDate(raw) : String(raw ?? '').trim();
      if (value !== '') r[field.key] = value;
    }
    out.push(r);
  }
  return out;
}

const DIETS: Record<string, string> = {
  '': 'veg', veg: 'veg', vegetarian: 'veg', nonveg: 'nonveg', nonvegetarian: 'nonveg', nv: 'nonveg', jain: 'jain',
};
const LANGUAGES: Record<string, string> = {
  '': 'en', en: 'en', english: 'en', or: 'or', od: 'or', odia: 'or', oriya: 'or', hi: 'hi', hindi: 'hi',
};

export interface RowIssue {
  /** 1-based position in the submitted rows (matches the server report). */
  row: number;
  errors: ImportErrorCode[];
}

/**
 * Client-side preview. Catches everything except `already_exists`, which only
 * the server can know. planNames: the kitchen's active plan names.
 */
export function validateImportRows(rows: ImportRow[], planNames: string[]): RowIssue[] {
  const plans = new Set(planNames.map((p) => p.trim().toLowerCase()));
  const seen = new Set<string>();
  const issues: RowIssue[] = [];

  rows.forEach((r, i) => {
    const errors: ImportErrorCode[] = [];
    if (!r.name?.trim()) errors.push('name_required');

    const phone = normalizePhone(r.phone);
    if (!phone) errors.push('invalid_phone');
    else if (seen.has(phone)) errors.push('duplicate_in_file');

    if (DIETS[(r.diet ?? '').toLowerCase().replace(/[^a-z]/g, '')] === undefined) errors.push('invalid_diet');
    if (LANGUAGES[(r.language ?? '').trim().toLowerCase()] === undefined) errors.push('invalid_language');
    if (r.plan?.trim() && !plans.has(r.plan.trim().toLowerCase())) errors.push('unknown_plan');
    if (r.start_date) {
      const ok = /^\d{4}-\d{2}-\d{2}$/.test(r.start_date) && !Number.isNaN(Date.parse(r.start_date));
      if (!ok) errors.push('invalid_date');
      if (!r.plan?.trim()) errors.push('start_date_requires_plan');
    }
    if (r.qty && !(/^\d{1,2}$/.test(r.qty) && Number(r.qty) >= 1 && Number(r.qty) <= 20)) errors.push('invalid_qty');
    const num = /^-?\d+(\.\d+)?$/;
    if (Boolean(r.lat) !== Boolean(r.lng) || (r.lat && !(num.test(r.lat) && num.test(r.lng ?? '')))) {
      errors.push('invalid_location');
    }

    if (errors.length) issues.push({ row: i + 1, errors });
    // Like the server, only rows that would be saved claim their phone number.
    if (phone && errors.length === 0) seen.add(phone);
  });
  return issues;
}

/** Template the vendor can download and fill in. */
export const IMPORT_TEMPLATE_HEADERS = [
  'Name', 'Phone', 'Diet', 'Language', 'Flat / house', 'Area', 'Landmark', 'Delivery notes', 'Notes', 'Plan',
  'Start date', 'Tiffins per meal',
];
