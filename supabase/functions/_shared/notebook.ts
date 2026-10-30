// Notebook-photo import (P6): guardrails for rows the AI read from a photo of the vendor's paper
// register. Pure logic, no external imports (unit-tested from Node in tests/integration).
//
// Rules
//   * Never invent values: anything empty or unreadable stays null. Only phones and meal counts are
//     normalised; names, flats, areas and notes are kept as read (trimmed).
//   * Phones go through the same rules as @tiffin/core normalizePhone (kept in sync; a shared test
//     compares both). Invalid or missing phones are flagged, never guessed.
//   * Meals left are only a suggestion (suggested_balance_meals). They are NOT part of import_rows:
//     the owner confirms an opening balance per customer before it becomes a ledger entry.
//   * Nothing is written here. The owner confirms the preview through public.import_customers,
//     which re-validates every row server-side.

/** Same rules as packages/core/src/phone.ts normalizePhone (keep in sync). */
export function normalizePhone(input: unknown): string | null {
  let digits = String(input ?? '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
}

export type RawRow = {
  name?: unknown;
  phone?: unknown;
  flat?: unknown;
  area?: unknown;
  plan?: unknown;
  meals_left?: unknown;
  notes?: unknown;
  confidence?: unknown;
};

export type Flag =
  | 'missing_name'
  | 'missing_phone'
  | 'invalid_phone'
  | 'duplicate_phone'
  | 'unknown_plan'
  | 'low_confidence'
  | 'check_balance'
  | 'invalid_meals_left';

export type PreviewRow = {
  row: number;
  name: string | null;
  phone: string | null;
  phone_raw: string | null;
  line1: string | null;
  area: string | null;
  plan: string | null;
  plan_raw: string | null;
  suggested_balance_meals: number | null;
  notes: string | null;
  confidence: number | null;
  flags: Flag[];
  importable: boolean;
};

/** The shape public.import_customers takes (no balance: that needs the owner's confirmation). */
export type ImportRow = { name: string; phone: string; line1?: string; area?: string; plan?: string; notes?: string };

export type Preview = {
  rows: PreviewRow[];
  import_rows: ImportRow[];
  summary: { total: number; importable: number; flagged: number; with_balance_suggestion: number };
};

export const LOW_CONFIDENCE = 0.7;
export const MAX_ROWS = 200;

/** JSON schema the model must answer with (structured output). */
export const NOTEBOOK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rows'],
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'phone', 'flat', 'area', 'plan', 'meals_left', 'notes', 'confidence'],
        properties: {
          name: { type: ['string', 'null'] },
          phone: { type: ['string', 'null'] },
          flat: { type: ['string', 'null'] },
          area: { type: ['string', 'null'] },
          plan: { type: ['string', 'null'] },
          meals_left: { type: ['string', 'null'] },
          notes: { type: ['string', 'null'] },
          confidence: { type: 'number' },
        },
      },
    },
  },
} as const;

export function notebookPrompt(plans: string[]): string {
  return [
    'This is a photo of a tiffin vendor\'s handwritten customer register (Bhubaneswar, India; English, Odia or Hindi).',
    'Transcribe one row per customer, exactly as written. Do not guess, complete or correct anything.',
    'Use null for any field that is missing, crossed out or unreadable. Never make up a phone number.',
    'Fields: name, phone (digits as written), flat (house/flat/room), area, plan (as written), meals_left',
    '(meals or days remaining, as written), notes (anything else on the row, e.g. "no onion").',
    'confidence: 0 to 1, how sure you are the whole row is read correctly.',
    plans.length ? `The kitchen's plan names (for reference only, do not force a match): ${plans.join(', ')}.` : '',
  ].filter(Boolean).join('\n');
}

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s && !/^(null|n\/a|na|-+|\?+)$/i.test(s) ? s.slice(0, 200) : null;
};

/** Reads the model's answer: {"rows": [...]} (optionally inside a ```json fence) or a bare array. */
export function parseModelOutput(output: string): RawRow[] {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(output);
  const body = (fenced ? fenced[1]! : output).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('unreadable_output');
  }
  const rows = Array.isArray(parsed) ? parsed : (parsed as { rows?: unknown })?.rows;
  if (!Array.isArray(rows)) throw new Error('unreadable_output');
  return rows.filter((r): r is RawRow => typeof r === 'object' && r !== null).slice(0, MAX_ROWS);
}

/** Matches a written plan to one of the kitchen's plans (exact, else the only one that contains it). */
export function matchPlan(written: string | null, plans: string[]): string | null {
  if (!written) return null;
  const w = written.toLowerCase();
  const exact = plans.find((p) => p.toLowerCase() === w);
  if (exact) return exact;
  const partial = plans.filter((p) => p.toLowerCase().includes(w) || w.includes(p.toLowerCase()));
  return partial.length === 1 ? partial[0]! : null;
}

/** Meals left as written ("12", "12 meals", "12 din") → integer 0..1000, else null + flag. */
function mealsLeft(v: unknown): { value: number | null; invalid: boolean } {
  const s = text(v);
  if (s === null) return { value: null, invalid: false };
  const m = /^(-?\d{1,4})\b/.exec(s);
  if (!m) return { value: null, invalid: true };
  const n = Number(m[1]);
  return n >= 0 && n <= 1000 ? { value: n, invalid: false } : { value: null, invalid: true };
}

export function buildPreview(rows: RawRow[], opts: { plans: string[] }): Preview {
  const seen = new Set<string>();
  const out: PreviewRow[] = rows.slice(0, MAX_ROWS).map((r, i) => {
    const flags: Flag[] = [];
    const name = text(r.name);
    const phoneRaw = text(r.phone);
    const phone = normalizePhone(phoneRaw);
    if (!name) flags.push('missing_name');
    if (!phoneRaw) flags.push('missing_phone');
    else if (!phone) flags.push('invalid_phone');
    else if (seen.has(phone)) flags.push('duplicate_phone');
    if (phone) seen.add(phone);
    const planRaw = text(r.plan);
    const plan = matchPlan(planRaw, opts.plans);
    if (planRaw && !plan) flags.push('unknown_plan');
    const meals = mealsLeft(r.meals_left);
    if (meals.invalid) flags.push('invalid_meals_left');
    if (meals.value !== null) flags.push('check_balance');
    const confidence = typeof r.confidence === 'number' && Number.isFinite(r.confidence)
      ? Math.max(0, Math.min(1, r.confidence)) : null;
    if (confidence === null || confidence < LOW_CONFIDENCE) flags.push('low_confidence');
    const importable = Boolean(name && phone) && !flags.includes('duplicate_phone');
    return {
      row: i + 1, name, phone, phone_raw: phoneRaw, line1: text(r.flat), area: text(r.area), plan, plan_raw: planRaw,
      suggested_balance_meals: meals.value, notes: text(r.notes), confidence, flags, importable,
    };
  });
  const importRows: ImportRow[] = out.filter((r) => r.importable).map((r) => {
    const row: ImportRow = { name: r.name!, phone: r.phone! };
    if (r.line1) row.line1 = r.line1;
    if (r.area) row.area = r.area;
    if (r.plan) row.plan = r.plan;
    if (r.notes) row.notes = r.notes;
    return row;
  });
  return {
    rows: out,
    import_rows: importRows,
    summary: {
      total: out.length,
      importable: importRows.length,
      flagged: out.filter((r) => r.flags.some((f) => f !== 'check_balance')).length,
      with_balance_suggestion: out.filter((r) => r.suggested_balance_meals !== null).length,
    },
  };
}

/** Fixture answer used when ANTHROPIC_API_KEY is not set (local development and tests). */
export const MOCK_MODEL_OUTPUT = JSON.stringify({
  rows: [
    { name: 'Ramesh Panda', phone: '98610 12345', flat: 'Flat 2B', area: 'Patia', plan: 'veg lunch', meals_left: '12', notes: null, confidence: 0.93 },
    { name: 'Sunita Behera', phone: '094370 22222', flat: 'House 14', area: 'KIIT Square', plan: null, meals_left: null, notes: 'no onion', confidence: 0.88 },
    { name: 'Bikash', phone: '98610 1234', flat: null, area: 'Infocity', plan: 'Veg Lunch', meals_left: '5 din', notes: null, confidence: 0.55 },
    { name: null, phone: '7008123456', flat: 'Room 7', area: null, plan: null, meals_left: null, notes: 'name smudged', confidence: 0.4 },
  ],
});
