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

const qty = (n: unknown, unit: unknown) => `${Number(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 3 })} ${String(unit ?? '')}`.trim();
function stockAlertText(p: Payload): string {
  if (p.kind === 'price_jump') return `${p.item} price up ${p.pct}% (${rupees(p.from_paise)} → ${rupees(p.to_paise)} per ${p.unit})`;
  if (p.kind === 'variance') return `stock-take found ${p.item} ${Number(p.variance) < 0 ? 'short' : 'over'} by ${qty(Math.abs(Number(p.variance)), p.unit)}${p.reason ? ` (${p.reason})` : ''}`;
  return `${p.item} is low: ${qty(p.stock, p.unit)} left (minimum ${qty(p.min_qty, p.unit)})`;
}

const VENDOR_STEP: Record<string, string> = {
  signup: 'log in with this WhatsApp number and create your kitchen',
  profile: 'add a short description and a photo of your food',
  location: 'set your kitchen location',
  fssai: 'add your FSSAI number (needed to receive customers from us)',
  plans: 'add your meal plans and prices',
  menu: "publish this week's menu",
  payout: 'finish payout KYC so customers can pay you online',
  customers: 'import your existing customers (Excel or contacts)',
  rider: 'invite your delivery rider',
  live: 'ask us to list your kitchen',
};

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
  on_the_way: {
    name: 'on_the_way_v1', category: 'UTILITY',
    text: {
      en: '{{1}}: your {{2}} is on the way with {{3}} (stop {{4}} of {{5}}). Delivery code: {{6}}. Share it only when you receive your tiffin.',
      hi: '{{1}}: आपका {{2}} {{3}} के साथ रास्ते में है ({{5}} में से स्टॉप {{4}})। डिलीवरी कोड: {{6}}। टिफिन मिलने पर ही बताएँ।',
      or: '{{1}}: ଆପଣଙ୍କ {{2}} {{3}}ଙ୍କ ସହ ବାଟରେ ଅଛି ({{5}}ରୁ ଷ୍ଟପ୍ {{4}})। ଡେଲିଭରି କୋଡ୍: {{6}}। ଟିଫିନ୍ ପାଇଲେ ହିଁ କୁହନ୍ତୁ।',
    },
    params: (p, k) => [k, p.slot === 'dinner' ? 'dinner' : 'lunch', String(p.rider_name ?? 'our rider'), String(p.stop ?? ''),
      String(p.stops ?? ''), String(p.otp ?? '')],
  },
  delivery_credit: {
    name: 'delivery_credit_v1', category: 'UTILITY',
    text: {
      en: '{{1}}: sorry, your {{2}} on {{3}} could not be delivered. {{4}} meal(s) have been added back to your balance.',
      hi: '{{1}}: माफ़ कीजिए, {{3}} का आपका {{2}} नहीं पहुँच सका। {{4}} खाना आपके बैलेंस में वापस जोड़ दिया गया है।',
      or: '{{1}}: କ୍ଷମା କରିବେ, {{3}}ର ଆପଣଙ୍କ {{2}} ପହଞ୍ଚିପାରିଲା ନାହିଁ। {{4}}ଟି ଖାଇବା ଆପଣଙ୍କ ବାଲାନ୍ସରେ ଫେରାଇ ଦିଆଗଲା।',
    },
    params: (p, k) => [k, p.slot === 'dinner' ? 'dinner' : 'lunch', day(p.service_date), String(p.meals ?? 1)],
  },
  trial_followup: {
    name: 'trial_followup_v1', category: 'UTILITY',
    text: {
      en: '{{1}}: hope you are enjoying your trial meals! Continue with {{2}}: {{3}} meals for {{4}}. Pay here: {{5}}',
      hi: '{{1}}: उम्मीद है ट्रायल खाना पसंद आ रहा है! {{2}} जारी रखें: {{3}} खाने {{4}} में। यहाँ भुगतान करें: {{5}}',
      or: '{{1}}: ଆଶା କରୁ ଟ୍ରାଏଲ୍ ଖାଇବା ଭଲ ଲାଗୁଛି! {{2}} ଜାରି ରଖନ୍ତୁ: {{3}}ଟି ଖାଇବା {{4}}ରେ। ଏଠାରେ ପେମେଣ୍ଟ କରନ୍ତୁ: {{5}}',
    },
    params: (p, k) => [k, String(p.plan_name ?? ''), String(p.meals ?? ''), rupees(p.amount_paise), String(p.url ?? '')],
  },
  // Platform messages to people who are not a kitchen's customer yet (leads, vendor applicants).
  lead_welcome: {
    name: 'lead_welcome_v1', category: 'UTILITY',
    text: {
      en: 'Namaskar {{1}}! Thanks for your tiffin enquiry. Tap below and we will show you home kitchens near you with space.',
      hi: 'नमस्कार {{1}}! टिफिन पूछताछ के लिए धन्यवाद। नीचे दबाएँ, हम आपके पास के खाली किचन दिखाएँगे।',
      or: 'ନମସ୍କାର {{1}}! ଟିଫିନ୍ ପଚାରିଥିବାରୁ ଧନ୍ୟବାଦ। ତଳେ ଦବାନ୍ତୁ, ଆମେ ଆପଣଙ୍କ ପାଖର ଖାଲି କିଚେନ୍ ଦେଖାଇବୁ।',
    },
    params: (p) => [String(p.name ?? 'there')],
    quickReplies: () => [{ payload: 'lead_start', title: { en: 'Find my tiffin', hi: 'टिफिन ढूँढें', or: 'ଟିଫିନ୍ ଖୋଜନ୍ତୁ' } }],
  },
  lead_reminder: {
    name: 'lead_reminder_v1', category: 'UTILITY',
    text: {
      en: 'Namaskar! The kitchens we found near you still have space: {{1}}. Tap below to see them again.',
      hi: 'नमस्कार! आपके पास के किचन में अभी भी जगह है: {{1}}। फिर से देखने के लिए नीचे दबाएँ।',
      or: 'ନମସ୍କାର! ଆପଣଙ୍କ ପାଖ କିଚେନ୍‌ରେ ଏବେ ବି ଜାଗା ଅଛି: {{1}}। ପୁଣି ଦେଖିବାକୁ ତଳେ ଦବାନ୍ତୁ।',
    },
    params: (p) => [((p.kitchens as { name: string }[] | undefined) ?? []).map((k) => k.name).join(', ') || 'see the list'],
    quickReplies: () => [{ payload: 'l_show', title: { en: 'Show kitchens', hi: 'किचन दिखाएँ', or: 'କିଚେନ୍ ଦେଖାନ୍ତୁ' } }],
  },
  vendor_welcome: {
    name: 'vendor_welcome_v1', category: 'UTILITY',
    text: {
      en: 'Namaskar {{1}}! Thank you for joining Tiffin OS. It is free. Log in with this number to set up your kitchen: {{2}}',
      hi: 'नमस्कार {{1}}! Tiffin OS से जुड़ने के लिए धन्यवाद। यह मुफ़्त है। किचन सेट करने के लिए इसी नंबर से लॉग इन करें: {{2}}',
      or: 'ନମସ୍କାର {{1}}! Tiffin OSରେ ଯୋଗ ଦେଇଥିବାରୁ ଧନ୍ୟବାଦ। ଏହା ମାଗଣା। କିଚେନ୍ ସେଟ୍ କରିବାକୁ ଏହି ନମ୍ବରରେ ଲଗଇନ୍ କରନ୍ତୁ: {{2}}',
    },
    params: (p) => [String(p.name ?? ''), String(p.url ?? '')],
  },
  vendor_nudge: {
    name: 'vendor_nudge_v1', category: 'UTILITY',
    text: {
      en: 'Namaskar {{1}}! Your next step on Tiffin OS: {{2}}. Open: {{3}}',
      hi: 'नमस्कार {{1}}! Tiffin OS पर आपका अगला कदम: {{2}}। खोलें: {{3}}',
      or: 'ନମସ୍କାର {{1}}! Tiffin OSରେ ଆପଣଙ୍କ ପରବର୍ତ୍ତୀ ପଦକ୍ଷେପ: {{2}}। ଖୋଲନ୍ତୁ: {{3}}',
    },
    params: (p) => [String(p.name ?? ''), VENDOR_STEP[String(p.next_step)] ?? 'finish setting up your kitchen', String(p.url ?? '')],
  },
  // To the kitchen owner (English).
  new_platform_customer: {
    name: 'new_platform_customer_v1', category: 'UTILITY',
    text: { en: '{{1}}: new customer from Tiffin platform: {{2}} ({{3}}), {{4}}, trial of {{5}} meals. They are in Customers in the app.' },
    params: (p, k) => [k, String(p.customer_name ?? 'A customer'), String(p.area ?? '—'), String(p.plan_name ?? ''), String(p.trial_meals ?? '')],
  },
  owner_daily_summary: {
    name: 'owner_summary_v1', category: 'UTILITY',
    text: { en: '{{1}} for {{2}}: lunch {{3}} meals, dinner {{4}} meals (preview until cutoff). Collections today: {{5}}. Low stock: {{6}}.' },
    params: (p, k) => [k, day(p.service_date), String(p.lunch?.total_meals ?? 0), String(p.dinner?.total_meals ?? 0),
      p.collections_paise == null ? 'see app' : rupees(p.collections_paise),
      (p.low_stock as string[] | undefined)?.length ? (p.low_stock as string[]).join(', ') : 'none'],
  },
  production_sheet: {
    name: 'production_sheet_v1', category: 'UTILITY',
    text: { en: '{{1}} final count for {{2}} {{3}}: {{4}} meals (veg {{5}}, non-veg {{6}}, Jain {{7}}). Packing list is in the app.' },
    params: (p, k) => [k, day(p.service_date), String(p.slot), String(p.totals?.total_meals ?? 0),
      String(p.totals?.by_diet?.veg ?? 0), String(p.totals?.by_diet?.nonveg ?? 0), String(p.totals?.by_diet?.jain ?? 0)],
  },
  stock_alert: {
    name: 'stock_alert_v1', category: 'UTILITY',
    text: { en: '{{1}} stock alert: {{2}}. Details are in the app.' },
    params: (p, k) => [k, stockAlertText(p)],
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
