// Customer import: column mapping + preview validation. The server
// (public.import_customers) re-validates and is authoritative; error codes match.

import { normalizePhone } from './phone';
import { addDays, isIsoDate } from './time';

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
  { key: 'plan_2', label: 'Second plan', required: false, aliases: ['plan 2', 'plan2', 'second plan', '2nd plan', 'dinner plan', 'evening plan', 'night plan'] },
  { key: 'start_date', label: 'Start date', required: false, aliases: ['start date', 'start', 'from', 'joining date', 'date'] },
  { key: 'qty', label: 'Tiffins per meal', required: false, aliases: ['qty', 'quantity', 'tiffins', 'count'] },
  // Exact header matches only: 'Payment status' or an address 'State' column must never be taken as this.
  { key: 'status', label: 'Status (active / paused / stopped)', required: false, exact: true,
    aliases: ['status', 'status (active / paused / stopped)', 'active/paused', 'current status', 'subscription status', 'tiffin status'] },
  { key: 'paused_from', label: 'Paused from', required: false, aliases: ['paused from', 'pause from', 'paused since', 'paused on', 'pause date', 'pause start'] },
  { key: 'balance', label: 'Opening balance (meals)', required: false, aliases: ['balance', 'opening balance', 'meals left', 'advance meals', 'remaining meals'] },
  { key: 'billing', label: 'Billing (monthly / prepaid)', required: false, aliases: ['billing', 'billing mode', 'monthly/prepaid', 'pay later', 'prepaid'] },
  { key: 'dues', label: 'Opening dues (₹)', required: false, aliases: ['dues', 'opening dues', 'due', 'khata', 'amount due', 'baki', 'pending amount'] },
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
  | 'invalid_balance'
  | 'invalid_location'
  | 'invalid_billing'
  | 'invalid_dues'
  | 'dues_need_monthly'
  | 'unknown_second_plan'
  | 'same_plan_twice'
  | 'invalid_status'
  | 'invalid_pause_date'
  | 'paused_from_needs_paused'
  | 'balance_on_repeated_row';

export const IMPORT_ERROR_MESSAGES: Record<ImportErrorCode, string> = {
  name_required: 'Name is missing',
  invalid_phone: 'Phone is not a valid 10-digit Indian mobile number',
  duplicate_in_file: 'Same name and phone number appear earlier in this file',
  already_exists: 'A customer with this name and phone number already exists',
  invalid_diet: 'Diet must be Veg, Non-veg or Jain',
  invalid_language: 'Language must be English, Odia or Hindi',
  unknown_plan: 'No active plan with this name',
  invalid_date: 'Start date is not a valid date',
  start_date_requires_plan: 'Start date given without a plan',
  invalid_qty: 'Tiffins per meal must be a number from 1 to 20',
  invalid_balance: 'Opening balance must be a whole number of meals (-200 to 1000)',
  invalid_location: 'Latitude and longitude must both be numbers',
  invalid_billing: 'Billing must be Monthly (pay later) or Prepaid',
  invalid_dues: 'Opening dues must be an amount in rupees (up to ₹1,00,000)',
  dues_need_monthly: 'Only monthly (pay later) customers can start with dues in rupees',
  unknown_second_plan: "No active plan with the second plan's name",
  same_plan_twice: 'This plan is already on this customer (for more tiffins use Tiffins per meal)',
  invalid_status: 'Status must be Active, Paused or Stopped',
  invalid_pause_date: 'Paused-from date is not a valid date',
  paused_from_needs_paused: 'A paused-from date needs status Paused (or leave status blank)',
  balance_on_repeated_row: "Put the opening balance and dues on this customer's first row only",
};

/** Not errors: the row is saved, but the vendor should know. */
export type ImportWarningCode = 'diet_differs_from_plan' | 'stopped_plan_ignored' | 'adds_plan';

export const IMPORT_WARNING_MESSAGES: Record<ImportWarningCode, string> = {
  diet_differs_from_plan: "Diet differs from the plan's diet: meals are cooked to the plan",
  stopped_plan_ignored: 'Stopped: saved with any dues, but no plan',
  adds_plan: 'Adds this plan to the same customer on an earlier row',
};

export function importWarningMessage(code: string): string {
  return IMPORT_WARNING_MESSAGES[code as ImportWarningCode] ?? code;
}

export type ImportStatusValue = 'active' | 'paused' | 'stopped';

/** Status column → status (same words as private.parse_import_status); null = not understood. Blank = active. */
export function parseImportStatus(value: string | undefined): ImportStatusValue | null {
  const v = (value ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (['', 'active', 'running', 'on', 'yes', 'chalu'].includes(v)) return 'active';
  if (['paused', 'pause', 'hold', 'onhold', 'break'].includes(v)) return 'paused';
  if (['stopped', 'stop', 'left', 'inactive', 'closed', 'cancelled', 'canceled', 'discontinued', 'off', 'no', 'band'].includes(v)) {
    return 'stopped';
  }
  return null;
}

export type BillingModeValue = 'monthly' | 'prepaid';

/** Billing column → billing mode (same words as the server); '' = the kitchen default; null = not understood. */
export function parseBilling(value: string | undefined): BillingModeValue | '' | null {
  const v = (value ?? '').trim().toLowerCase();
  if (v === '') return '';
  if (['monthly', 'month', 'month end', 'pay later', 'paylater', 'postpaid', 'khata', 'credit'].includes(v)) return 'monthly';
  if (['prepaid', 'advance', 'pre-paid'].includes(v)) return 'prepaid';
  return null;
}

/** Same comparison as private.same_name: case and repeated spaces ignored. */
export function sameName(a: string | undefined, b: string | undefined): boolean {
  const n = (s: string | undefined) => (s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  return n(a) === n(b);
}

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
          field.aliases.some((a) =>
            pass === 'exact' ? h === clean(a) : !('exact' in field && field.exact) && h.includes(clean(a)),
          ),
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
      const value = field.key === 'start_date' || field.key === 'paused_from' ? normalizeDate(raw) : String(raw ?? '').trim();
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

export interface RowWarning {
  row: number;
  warnings: ImportWarningCode[];
  /** For 'adds_plan': the earlier row of the same customer. */
  into?: number;
}

/** A plan as the preview needs it: its name and (optionally) its diet, to warn about diet mismatches. */
export type ImportPlan = { name: string; diet?: string | null };

const planKey = (s: string | undefined) => (s ?? '').trim().toLowerCase();
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/**
 * Client-side preview with the same rules as public.import_customers. Catches everything except
 * `already_exists`, which only the server can know. plans: the kitchen's active plans (names, or
 * names with diets); defaultBilling: the kitchen's default billing mode (for rows with a blank billing column).
 *   - D-118: several customers may share a phone; only the same phone AND the same name is one person.
 *   - A repeated row of the same person adds its plan(s) to the earlier row's customer. It fails as
 *     `duplicate_in_file` when it adds nothing; opening balance and dues belong on the first row.
 *   - Status: active (blank) | paused (from 'paused_from'; a paused-from date alone means paused) | stopped.
 *   - Warnings never block a row: a diet that differs from a plan's diet, a stopped row's plan, a repeated row.
 */
export function previewImportRows(
  rows: ImportRow[],
  plans: (string | ImportPlan)[],
  defaultBilling: BillingModeValue = 'monthly',
): { issues: RowIssue[]; warnings: RowWarning[] } {
  const planDiet = new Map<string, string | null>();
  for (const p of plans) {
    if (typeof p === 'string') planDiet.set(planKey(p), null);
    else planDiet.set(planKey(p.name), p.diet ?? null);
  }
  // Saved rows by phone: the name, the row and the plans that customer has from this file.
  const seen = new Map<string, { name: string; row: number; plans: Set<string> }[]>();
  const issues: RowIssue[] = [];
  const warnings: RowWarning[] = [];

  rows.forEach((r, i) => {
    const errors: ImportErrorCode[] = [];
    const notes: ImportWarningCode[] = [];
    if (!r.name?.trim()) errors.push('name_required');

    const phone = normalizePhone(r.phone);
    const earlier = phone ? (seen.get(phone) ?? []).find((e) => sameName(e.name, r.name)) : undefined;
    if (!phone) errors.push('invalid_phone');

    const diet = DIETS[(r.diet ?? '').toLowerCase().replace(/[^a-z]/g, '')];
    if (diet === undefined) errors.push('invalid_diet');
    if (LANGUAGES[(r.language ?? '').trim().toLowerCase()] === undefined) errors.push('invalid_language');

    const rowPlans: string[] = [];
    if (r.plan?.trim()) {
      if (!planDiet.has(planKey(r.plan))) errors.push('unknown_plan');
      else rowPlans.push(planKey(r.plan));
    }
    if (r.plan_2?.trim()) {
      if (!planDiet.has(planKey(r.plan_2))) errors.push('unknown_second_plan');
      else if (rowPlans.includes(planKey(r.plan_2))) errors.push('same_plan_twice');
      else rowPlans.push(planKey(r.plan_2));
    }
    if (r.start_date) {
      if (!isDate(r.start_date)) errors.push('invalid_date');
      if (!r.plan?.trim() && !r.plan_2?.trim()) errors.push('start_date_requires_plan');
    }
    if (r.qty && !(/^\d{1,2}$/.test(r.qty) && Number(r.qty) >= 1 && Number(r.qty) <= 20)) errors.push('invalid_qty');

    let status = parseImportStatus(r.status);
    if (status === null) errors.push('invalid_status');
    if (r.paused_from) {
      if (!isDate(r.paused_from)) errors.push('invalid_pause_date');
      if (!r.status?.trim()) status = 'paused';
      else if (status !== 'paused') errors.push('paused_from_needs_paused');
    }

    if (r.balance && !(/^-?\d{1,4}$/.test(r.balance) && Number(r.balance) >= -200 && Number(r.balance) <= 1000)) errors.push('invalid_balance');
    const billing = parseBilling(r.billing);
    if (billing === null) errors.push('invalid_billing');
    if (r.dues) {
      if (/^-?\d{1,6}(\.\d{1,2})?$/.test(r.dues) && Math.abs(Number(r.dues)) <= 100000) {
        if ((billing || defaultBilling) !== 'monthly' && Number(r.dues) !== 0) errors.push('dues_need_monthly');
      } else errors.push('invalid_dues');
    }
    const num = /^-?\d+(\.\d+)?$/;
    if (Boolean(r.lat) !== Boolean(r.lng) || (r.lat && !(num.test(r.lat) && num.test(r.lng ?? '')))) {
      errors.push('invalid_location');
    }

    // A repeated row only adds plans to the earlier row's customer.
    if (earlier) {
      if (rowPlans.length === 0 || status === 'stopped') errors.push('duplicate_in_file');
      else if (r.balance?.trim() || r.dues?.trim()) errors.push('balance_on_repeated_row');
      else if (rowPlans.some((p) => earlier.plans.has(p))) errors.push('same_plan_twice');
    }

    if (errors.length === 0) {
      if (earlier) notes.push('adds_plan');
      if (status === 'stopped' && rowPlans.length > 0) notes.push('stopped_plan_ignored');
      const planDiets = rowPlans.map((p) => planDiet.get(p)).filter((d): d is string => d != null);
      if (r.diet?.trim() && status !== 'stopped' && planDiets.some((d) => d !== diet)) notes.push('diet_differs_from_plan');
    }

    if (errors.length) issues.push({ row: i + 1, errors });
    if (notes.length) warnings.push({ row: i + 1, warnings: notes, ...(earlier ? { into: earlier.row } : {}) });
    // Like the server, only rows that are saved claim their phone number (with their name).
    if (phone && errors.length === 0) {
      if (earlier) {
        if (status !== 'stopped') rowPlans.forEach((p) => earlier.plans.add(p));
      } else {
        const entry = { name: r.name ?? '', row: i + 1, plans: new Set(status === 'stopped' ? [] : rowPlans) };
        seen.set(phone, [...(seen.get(phone) ?? []), entry]);
      }
    }
  });
  return { issues, warnings };
}

/** Errors only (see previewImportRows). */
export function validateImportRows(
  rows: ImportRow[],
  plans: (string | ImportPlan)[],
  defaultBilling: BillingModeValue = 'monthly',
): RowIssue[] {
  return previewImportRows(rows, plans, defaultBilling).issues;
}

/** Rows per import_customers call, so a register of hundreds of rows never hits the statement timeout. */
export const IMPORT_CHUNK_SIZE = 100;

/** Splits rows into chunks, each with the file position (1-based) of its first row. */
export function importChunks<T>(rows: T[], size: number = IMPORT_CHUNK_SIZE): { firstRow: number; rows: T[] }[] {
  const out: { firstRow: number; rows: T[] }[] = [];
  for (let i = 0; i < rows.length; i += Math.max(1, size)) out.push({ firstRow: i + 1, rows: rows.slice(i, i + Math.max(1, size)) });
  return out;
}

/** Template the vendor can download and fill in (the example rows follow the same order). */
export const IMPORT_TEMPLATE_HEADERS = [
  'Name', 'Phone', 'Diet', 'Language', 'Flat / house', 'Area', 'Landmark', 'Delivery notes', 'Notes', 'Plan', 'Second plan',
  'Start date', 'Tiffins per meal', 'Status (active / paused / stopped)', 'Paused from', 'Opening balance (meals)',
  'Billing (monthly / prepaid)', 'Opening dues (₹)',
];

const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/**
 * The template: header plus two example rows. The first fills every column (a monthly customer on two
 * plans of the same diet where the kitchen has them, paused from next week, with opening dues); the
 * second is a typical prepaid customer whose blank diet takes the plan's. Dates are written the Indian
 * way (dd/mm/yyyy) from today's IST date: pass istDate().
 */
export function importTemplateRows(plans: (string | ImportPlan)[], todayIst: string): string[][] {
  const list = plans.map((p) => (typeof p === 'string' ? { name: p, diet: null } : { name: p.name, diet: p.diet ?? null }));
  const first = list[0] ?? { name: 'Lunch', diet: null };
  const others = list.filter((p) => planKey(p.name) !== planKey(first.name));
  const second = others.find((p) => p.diet === first.diet) ?? others[0];
  const dietLabel = first.diet === 'nonveg' ? 'Non-veg' : first.diet === 'jain' ? 'Jain' : 'Veg';
  const today = isIsoDate(todayIst) ? todayIst : '2026-11-02';
  // Keyed by header, so a column added to IMPORT_TEMPLATE_HEADERS only needs an entry here ('Route' is
  // wave 3's column; unused until that header exists). A header with no entry stays blank.
  const asha: Record<string, string> = {
    Name: 'Asha Das', Phone: '9861012345', Diet: dietLabel, Language: 'Odia', 'Flat / house': 'Flat 2A', Area: 'Patia',
    Landmark: 'Near KIIT gate', 'Delivery notes': 'Call on arrival', Notes: 'Less oil', Plan: first.name,
    'Second plan': second?.name ?? '', 'Start date': ddmmyyyy(today), 'Tiffins per meal': '1',
    'Status (active / paused / stopped)': 'Paused', 'Paused from': ddmmyyyy(addDays(today, 7)),
    'Opening balance (meals)': '0', 'Billing (monthly / prepaid)': 'Monthly', 'Opening dues (₹)': '250', Route: 'Patia A',
  };
  const ravi: Record<string, string> = {
    Name: 'Ravi Nayak', Phone: '9861054321', Language: 'English', 'Flat / house': 'Plot 14', Area: 'Saheed Nagar',
    Landmark: 'Behind the temple', Plan: first.name, 'Start date': ddmmyyyy(today), 'Tiffins per meal': '2',
    'Status (active / paused / stopped)': 'Active', 'Opening balance (meals)': '10', 'Billing (monthly / prepaid)': 'Prepaid',
  };
  const row = (r: Record<string, string>) => IMPORT_TEMPLATE_HEADERS.map((h) => r[h] ?? '');
  return [IMPORT_TEMPLATE_HEADERS, row(asha), row(ravi)];
}
