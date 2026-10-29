// Message templates for business-initiated WhatsApp messages (notifications_outbox).
// Outside the 24-hour customer-service window Meta only allows approved templates; inside it we
// send the same content as a normal message. Template names/texts must match what is submitted
// to Meta (docs/WHATSAPP_TEMPLATES.md). Odia/Hindi texts are drafts (D-057).

import type { Lang } from './bot-i18n.ts';
import type { Out } from './whatsapp.ts';

type Payload = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const rupees = (paise: unknown) => `₹${(Number(paise ?? 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const day = (d: unknown) =>
  new Date(`${String(d)}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

type Def = {
  name: string;
  category: 'UTILITY' | 'MARKETING';
  text: Partial<Record<Lang, string>> & { en: string };
  params: (p: Payload, kitchen: string) => string[];
  /** Inside the 24h window, send this instead of the template text. */
  sessionText?: (p: Payload) => string;
  quickReplies?: (p: Payload) => { payload: string; title: Partial<Record<Lang, string>> & { en: string } }[];
};

export const TEMPLATES: Record<string, Def> = {
  payment_receipt: {
    name: 'payment_receipt_v1', category: 'UTILITY',
    text: {
      en: '{{1}}: payment of {{2}} received for {{3}} meals. Balance: {{4}} meals. Thank you!',
      hi: '{{1}}: {{3}} खानों के लिए {{2}} का भुगतान मिला। बैलेंस: {{4}} खाने। धन्यवाद!',
      or: '{{1}}: {{3}}ଟି ଖାଇବା ପାଇଁ {{2}} ପେମେଣ୍ଟ ମିଳିଲା। ବାଲାନ୍ସ: {{4}}ଟି ଖାଇବା। ଧନ୍ୟବାଦ!',
    },
    params: (p, k) => [k, rupees(p.amount_paise), String(p.meals), String(p.balance_meals ?? '')],
  },
  refund_notice: {
    name: 'refund_notice_v1', category: 'UTILITY',
    text: {
      en: '{{1}}: a refund of {{2}} for {{3}} unused meals has been created. You will be told when it is paid.',
      hi: '{{1}}: {{3}} बचे खानों के लिए {{2}} का रिफंड बनाया गया। भुगतान होने पर बताया जाएगा।',
      or: '{{1}}: {{3}}ଟି ବାକି ଖାଇବା ପାଇଁ {{2}} ରିଫଣ୍ଡ ତିଆରି ହେଲା। ପେମେଣ୍ଟ ହେଲେ ଜଣାଯିବ।',
    },
    params: (p, k) => [k, rupees(p.amount_paise), String(p.meals)],
  },
  refund_receipt: {
    name: 'refund_receipt_v1', category: 'UTILITY',
    text: {
      en: '{{1}}: your refund of {{2}} has been paid ({{3}}).',
      hi: '{{1}}: आपका {{2}} का रिफंड दे दिया गया ({{3}})।',
      or: '{{1}}: ଆପଣଙ୍କ {{2}} ରିଫଣ୍ଡ ଦିଆଗଲା ({{3}})।',
    },
    params: (p, k) => [k, rupees(p.amount_paise), String(p.method ?? '').replace('_manual', '')],
  },
  low_balance_reminder: {
    name: 'low_balance_v1', category: 'UTILITY',
    text: {
      en: '{{1}}: you have {{2}} meals left. Reply PAY to recharge.',
      hi: '{{1}}: आपके {{2}} खाने बाकी हैं। रिचार्ज के लिए PAY लिखें।',
      or: '{{1}}: ଆପଣଙ୍କର {{2}}ଟି ଖାଇବା ବାକି। ରିଚାର୍ଜ ପାଇଁ PAY ଲେଖନ୍ତୁ।',
    },
    params: (p, k) => [k, String(p.balance_meals ?? 0)],
  },
  dues_reminder: {
    name: 'dues_reminder_v1', category: 'UTILITY',
    text: {
      en: '{{1}}: {{2}} is due for {{3}} meals. Reply PAY to pay now.',
      hi: '{{1}}: {{3}} खानों के {{2}} बाकी हैं। अभी भुगतान के लिए PAY लिखें।',
      or: '{{1}}: {{3}}ଟି ଖାଇବାର {{2}} ବାକି। ଏବେ ଦେବାକୁ PAY ଲେଖନ୍ତୁ।',
    },
    params: (p, k) => [k, rupees(p.amount_owed_paise), String(p.meals_owed)],
  },
  tomorrow_menu: {
    name: 'tomorrow_menu_v1', category: 'UTILITY',
    text: {
      en: "{{1}}: tomorrow's menu ({{2}}): {{3}}. Not eating? Tap Skip before the cutoff.",
      hi: '{{1}}: कल का मेनू ({{2}}): {{3}}। नहीं खाना? कटऑफ से पहले Skip दबाएँ।',
      or: '{{1}}: କାଲିର ମେନୁ ({{2}}): {{3}}। ଖାଇବେ ନାହିଁ? କଟଅଫ୍ ପୂର୍ବରୁ Skip ଦବାନ୍ତୁ।',
    },
    params: (p, k) => [k, day(p.date), (p.dishes as string[] | undefined)?.length ? (p.dishes as string[]).join(', ') : 'chef’s choice'],
    quickReplies: (p) => [
      { payload: `nudge_skip|${p.date}`, title: { en: 'Skip tomorrow', hi: 'कल स्किप', or: 'କାଲି ସ୍କିପ୍' } },
      { payload: 'nudge_keep', title: { en: 'Keep', hi: 'चालू रखें', or: 'ରଖନ୍ତୁ' } },
    ],
  },
  vendor_message: {
    name: 'kitchen_message_v1', category: 'UTILITY',
    text: { en: 'Message from {{1}}: {{2}}', hi: '{{1}} का संदेश: {{2}}', or: '{{1}} ଙ୍କ ମେସେଜ୍: {{2}}' },
    params: (p, k) => [k, String(p.text ?? '')],
    sessionText: (p) => String(p.text ?? ''), // the customer is already chatting with the kitchen
  },
  broadcast: {
    name: 'kitchen_update_v1', category: 'MARKETING',
    text: { en: 'Update from {{1}}: {{2}}', hi: '{{1}} से सूचना: {{2}}', or: '{{1}} ଙ୍କ ସୂଚନା: {{2}}' },
    params: (p, k) => [k, String(p.text ?? '')],
  },
  // To the kitchen owner (English).
  owner_daily_summary: {
    name: 'owner_summary_v1', category: 'UTILITY',
    text: { en: '{{1}} for {{2}}: lunch {{3}} meals, dinner {{4}} meals (preview until cutoff). Collections today: {{5}}.' },
    params: (p, k) => [k, day(p.service_date), String(p.lunch?.total_meals ?? 0), String(p.dinner?.total_meals ?? 0),
      p.collections_paise == null ? 'see app' : rupees(p.collections_paise)],
  },
  production_sheet: {
    name: 'production_sheet_v1', category: 'UTILITY',
    text: { en: '{{1}} final count for {{2}} {{3}}: {{4}} meals (veg {{5}}, non-veg {{6}}, Jain {{7}}). Packing list is in the app.' },
    params: (p, k) => [k, day(p.service_date), String(p.slot), String(p.totals?.total_meals ?? 0),
      String(p.totals?.by_diet?.veg ?? 0), String(p.totals?.by_diet?.nonveg ?? 0), String(p.totals?.by_diet?.jain ?? 0)],
  },
  inbox_alert: {
    name: 'inbox_alert_v1', category: 'UTILITY',
    text: { en: '{{1}}: {{2}} needs a reply in your inbox ({{3}}).' },
    params: (p, k) => [k, String(p.customer_name ?? 'A customer'), p.complaint_id ? `complaint: ${p.category}` : String(p.reason ?? 'message')],
  },
};

const fill = (text: string, params: string[]) => params.reduce((s, v, i) => s.split(`{{${i + 1}}}`).join(v), text);

/**
 * Renders an outbox row. Inside the 24h window: a normal message (with buttons where the template
 * has quick replies). Outside: the approved template.
 */
export function renderOutbox(template: string, payload: Payload, lang: Lang, kitchenName: string, inWindow: boolean): Out | null {
  const def = TEMPLATES[template];
  if (!def) return null;
  const params = def.params(payload, kitchenName || 'Your kitchen');
  const useLang: Lang = def.text[lang] ? lang : 'en';
  const text = fill(def.text[useLang]!, params);
  const quick = def.quickReplies?.(payload) ?? [];
  if (inWindow) {
    if (def.sessionText) return { type: 'text', text: def.sessionText(payload) };
    return quick.length
      ? { type: 'buttons', text, buttons: quick.map((q) => ({ id: q.payload, title: q.title[useLang] ?? q.title.en })) }
      : { type: 'text', text };
  }
  return { type: 'template', name: def.name, language: useLang, params, quickReplies: quick.map((q) => q.payload), preview: text };
}

/** Templates that may be sent to customers who have not opted in (none: all need opt-in). */
export const CUSTOMER_TEMPLATES_WITHOUT_OPT_IN = new Set<string>();
