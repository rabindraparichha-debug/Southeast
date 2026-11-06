// The WhatsApp template pack for Meta / Twilio submission (D-154): every template the platform
// sends, with its category, variables and sample values, built from TEMPLATES so the CSV
// (docs/whatsapp-templates.csv) and docs/WHATSAPP_TEMPLATES.md cannot drift from what the code
// sends. tests/integration/template-pack.test.ts checks both files (UPDATE_TEMPLATE_PACK=1 rewrites
// the CSV). No external imports.

import { TEMPLATES } from './templates.ts';

export type Audience = 'customer' | 'payer' | 'platform' | 'owner' | 'login';
export type Category = 'UTILITY' | 'MARKETING' | 'AUTHENTICATION';

type Payload = Record<string, unknown>;

/** A realistic payload per template key (what the database puts in notifications_outbox.payload). */
export const TEMPLATE_SAMPLES: Record<string, { audience: Audience; payload: Payload }> = {
  payment_receipt: { audience: 'customer', payload: { amount_paise: 140000, meals: 20, balance_meals: 23 } },
  refund_notice: { audience: 'customer', payload: { amount_paise: 42000, meals: 6 } },
  refund_receipt: { audience: 'customer', payload: { amount_paise: 42000, method: 'upi_manual' } },
  low_balance_reminder: { audience: 'customer', payload: { balance_meals: 2 } },
  dues_reminder: { audience: 'customer', payload: { amount_owed_paise: 21000, meals_owed: 3 } },
  payment_receipt_monthly: { audience: 'customer', payload: { amount_paise: 150000, due_paise: 60000, advance_paise: 0 } },
  statement_ready: { audience: 'customer', payload: { month: '2026-10', meals: 26, charged_paise: 182000, amount_due_paise: 32000 } },
  tomorrow_menu: { audience: 'customer', payload: { date: '2026-11-17', dishes: ['Rice', 'Dalma', 'Aloo bhaja'] } },
  vendor_message: { audience: 'customer', payload: { text: 'Kitchen closed on Sunday for Kartika Purnima.' } },
  broadcast: { audience: 'customer', payload: { text: 'New dinner plan from December: roti, sabzi and dal for Rs 70.' } },
  on_the_way: { audience: 'customer', payload: { slot: 'lunch', rider_name: 'Bapi', stop: 4, stops: 12, otp: '4821' } },
  delivery_credit: { audience: 'customer', payload: { slot: 'lunch', service_date: '2026-11-16', meals: 1 } },
  trial_followup: { audience: 'customer', payload: { plan_name: 'Veg Lunch', meals: 26, amount_paise: 182000, url: 'https://app.example.in/c/Xy12Ab' } },
  low_balance_reminder_payer: { audience: 'payer', payload: { eater_name: 'Rohan', balance_meals: 2, url: 'https://app.example.in/c/Pq34Cd' } },
  dues_reminder_payer: { audience: 'payer', payload: { amount_owed_paise: 21000, eater_name: 'Rohan', meals_owed: 3, url: 'https://app.example.in/c/Pq34Cd' } },
  payment_receipt_payer: { audience: 'payer', payload: { amount_paise: 140000, meals: 20, eater_name: 'Rohan', balance_meals: 22 } },
  payment_receipt_monthly_payer: { audience: 'payer', payload: { amount_paise: 150000, eater_name: 'Rohan', due_paise: 60000, advance_paise: 0 } },
  statement_ready_payer: { audience: 'payer', payload: { month: '2026-10', eater_name: 'Rohan', meals: 26, charged_paise: 182000, amount_due_paise: 32000, url: 'https://app.example.in/c/Pq34Cd' } },
  refund_notice_payer: { audience: 'payer', payload: { amount_paise: 42000, meals: 6, eater_name: 'Rohan' } },
  refund_receipt_payer: { audience: 'payer', payload: { amount_paise: 42000, eater_name: 'Rohan', method: 'upi_manual' } },
  festival_special: { audience: 'customer', payload: { service_date: '2026-11-24', slot: 'lunch', name: 'Khiri and puri', addon_price_paise: null } },
  complaint_credit: { audience: 'customer', payload: { category: 'late', meals: 1 } },
  weather_delay_notice: { audience: 'customer', payload: { kind: 'rain', slot: 'lunch', service_date: '2026-11-17' } },
  referral_reward: { audience: 'customer', payload: { meals: 2, role: 'referrer', friend_name: 'Priya' } },
  kitchen_switch_approved: { audience: 'customer', payload: { from_kitchen: 'Saheed Nagar Mess', effective_date: '2026-11-20', url: 'https://app.example.in/c/Rs56Ef' } },
  lead_welcome: { audience: 'platform', payload: { name: 'Asha' } },
  lead_confirm: { audience: 'platform', payload: { name: 'Asha', kitchen_name: 'Maa Tarini Tiffin', trial_meals: 2, url: 'https://app.example.in/find/confirm/Ab12Cd34' } },
  lead_reminder: { audience: 'platform', payload: { kitchens: [{ name: 'Maa Tarini Tiffin' }, { name: 'Infocity Home Kitchen' }] } },
  vendor_welcome: { audience: 'platform', payload: { name: 'Sunita', url: 'https://app.example.in/login' } },
  vendor_nudge: { audience: 'platform', payload: { name: 'Sunita', next_step: 'plans', url: 'https://app.example.in/plans' } },
  new_platform_customer: { audience: 'owner', payload: { customer_name: 'Asha Das', area: 'Patia', plan_name: 'Veg Lunch', trial_meals: 2 } },
  referral_customer: { audience: 'owner', payload: { customer_name: 'Priya Nayak', area: 'Patia', referrer_name: 'Asha Das', plan_name: 'Veg Lunch', trial_meals: 2, start_date: '2026-11-17' } },
  referral_existing: { audience: 'owner', payload: { customer_name: 'Priya Nayak', referrer_name: 'Asha Das', plan_name: 'Veg Lunch', start_date: '2026-11-17', existing_name: 'Priya N' } },
  owner_daily_summary: { audience: 'owner', payload: { service_date: '2026-11-17', lunch: { total_meals: 64 }, dinner: { total_meals: 31 }, collections_paise: 350000, low_stock: ['Toor dal', 'Mustard oil'] } },
  production_sheet: { audience: 'owner', payload: { service_date: '2026-11-17', slot: 'lunch', totals: { total_meals: 64, by_diet: { veg: 50, nonveg: 12, jain: 2 } } } },
  stock_alert: { audience: 'owner', payload: { kind: 'low', item: 'Toor dal', stock: 4, unit: 'kg', min_qty: 5 } },
  weather_alert: { audience: 'owner', payload: { kind: 'rain', slot: 'lunch', service_date: '2026-11-17', detail: { max_rain_mm: 12 } } },
  late_delivery_alert: { audience: 'owner', payload: { pending_stops: 3, route_name: 'Patia', rider_name: 'Bapi', minutes: 90 } },
  customer_switched_out: { audience: 'owner', payload: { customer_name: 'Asha Das', effective_date: '2026-11-20' } },
  inbox_alert: { audience: 'owner', payload: { customer_name: 'Asha Das', reason: 'asked to talk to the kitchen' } },
  transfer_failed: { audience: 'owner', payload: { amount_paise: 182000, paid_at: '2026-11-16T07:30:00Z', error: 'Linked account is not active' } },
};

/** Sample kitchen name ({{1}} of most templates). */
export const SAMPLE_KITCHEN = 'Maa Tarini Tiffin';

/** Templates sent outside TEMPLATES (not through the outbox). */
export const EXTERNAL_TEMPLATES: {
  name: string; category: Category; audience: Audience; body: string; examples: string[]; buttons: string[]; source: string; notes: string;
}[] = [
  {
    name: 'tiffin_login_code', category: 'AUTHENTICATION', audience: 'login',
    body: '{{1}} is your verification code. For your security, do not share this code.',
    examples: ['482913'], buttons: ['Copy code'],
    source: 'auth-send-sms (WhatsApp login through Twilio: TWILIO_WHATSAPP_CONTENT_SID)',
    notes: 'Meta fixed authentication format (body text is set by Meta); add the Copy code button and a 10-minute expiry',
  },
];

export type PackRow = {
  name: string; category: Category; language: 'en' | 'hi' | 'or'; status: 'ready' | 'draft'; audience: Audience; source: string;
  body: string; examples: string[]; buttons: string[]; checks: string[];
};

const LANGS = ['en', 'hi', 'or'] as const;

/** Placeholder numbers used in a template body, sorted (a translation may use them in another order). */
export function placeholders(body: string): number[] {
  return [...new Set([...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])))].sort((x, y) => x - y);
}

/** Things to look at before submitting (Meta guidelines), as short notes. */
export function bodyChecks(body: string, examples: string[]): string[] {
  const out: string[] = [];
  const nums = placeholders(body);
  if (nums.length !== examples.length || nums.some((n, i) => n !== i + 1)) out.push(`variables ${nums.join(',')} vs ${examples.length} examples`);
  if (/^\s*\{\{\d+\}\}/.test(body)) out.push('starts with a variable');
  if (/\{\{\d+\}\}\s*$/.test(body)) out.push('ends with a variable');
  if (/\{\{\d+\}\}\s*\{\{\d+\}\}/.test(body)) out.push('two variables side by side');
  if (examples.some((e) => !String(e).trim())) out.push('empty example');
  return out;
}

export function templatePack(): PackRow[] {
  const rows: PackRow[] = [];
  for (const [key, def] of Object.entries(TEMPLATES)) {
    const sample = TEMPLATE_SAMPLES[key];
    if (!sample) throw new Error(`no sample for template ${key}`);
    const examples = def.params(sample.payload, SAMPLE_KITCHEN);
    const quick = def.quickReplies?.(sample.payload) ?? [];
    for (const lang of LANGS) {
      const body = def.text[lang];
      if (!body) continue;
      rows.push({
        name: def.name, category: def.category, language: lang, status: lang === 'en' ? 'ready' : 'draft', audience: sample.audience,
        source: `templates.ts:${key}`, body, examples, buttons: quick.map((q) => q.title[lang] ?? q.title.en),
        checks: bodyChecks(body, examples),
      });
    }
  }
  for (const t of EXTERNAL_TEMPLATES) {
    rows.push({ name: t.name, category: t.category, language: 'en', status: 'ready', audience: t.audience, source: t.source,
      body: t.body, examples: t.examples, buttons: t.buttons, checks: [t.notes] });
  }
  return rows;
}

const MAX_EXAMPLES = 7;
const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** CSV for Meta Business Manager / Twilio Content API submission (one row per template and language). */
export function packCsv(rows: PackRow[] = templatePack()): string {
  const header = ['name', 'category', 'language', 'status', 'audience', 'body', 'variables',
    ...Array.from({ length: MAX_EXAMPLES }, (_, i) => `example_${i + 1}`), 'quick_replies', 'source', 'checks'];
  const lines = [header.join(',')];
  for (const r of rows) {
    const ex = Array.from({ length: MAX_EXAMPLES }, (_, i) => r.examples[i] ?? '');
    lines.push([r.name, r.category.toLowerCase(), r.language, r.status, r.audience, r.body, String(r.examples.length), ...ex,
      r.buttons.join(' | '), r.source, r.checks.join('; ')].map((v) => csvCell(String(v))).join(','));
  }
  return `${lines.join('\n')}\n`;
}
