// WhatsApp bot for numbers that aren't any kitchen's customer yet: new-customer qualification
// (location, meal times, diet, budget, start date) → 2–3 matched kitchens → trial; and vendor
// sign-up ("Hi VENDOR"). Pure logic with injected deps (unit-tested in tests/integration/lead-bot.test.ts).
// No external imports. Odia/Hindi texts are DRAFTS (D-057).
import type { Lang } from './bot-i18n.ts';
import type { Inbound, Out } from './whatsapp.ts';

export type Shortlist = {
  kitchen_id: string; name: string; area: string | null; distance_km: number; plan_name: string;
  price_per_meal_paise: number; rating: number | null; reviews: number; trial_meals: number; profile_url: string;
};

export type Lead = {
  id: string;
  status: string;
  bot_step: string | null;
  name: string | null;
  area: string | null;
  lat: number | null;
  slots: string[] | null;
  diet: string | null;
  budget_per_meal_paise: number | null;
  start_date: string | null;
  language: Lang;
  kitchens: Shortlist[];
};

export type Chosen = { kitchen_name: string; plan_name: string; trial_meals: number; trial_amount_paise: number; portal_url: string };

export type LeadDeps = {
  /** Saves answers (upsert_lead keys) and the next step; 'matched' runs the matching. */
  update: (fields: Record<string, unknown>, step: string | null) => Promise<Lead>;
  choose: (kitchenId: string) => Promise<Chosen>;
  /** Today in IST, YYYY-MM-DD. */
  today: string;
};

export type VendorState = { flow: 'vendor'; step: 'v_kitchen' | 'v_area' | 'v_size'; kitchen_name?: string; area?: string; campaign?: string | null };
export type VendorDeps = {
  setState: (state: VendorState | Record<string, never>) => Promise<void>;
  apply: (a: { kitchen_name: string; area: string; subscribers: number | null; campaign: string | null }) => Promise<void>;
  signupUrl: string;
};

type Dict = Record<string, string>;
const en: Dict = {
  welcome: 'Namaskar{name}! 🍱 Looking for home-style tiffin near you? I can show you trusted kitchens nearby in a minute.',
  ask_location: 'Please *share your location* 📍 (tap + or 📎 → Location), or type your area, e.g. *Patia* or *Saheed Nagar*.',
  area_unknown: 'Sorry, I could not find that area. Please share your location 📍, or type a nearby area like Patia, Infocity or Saheed Nagar.',
  ask_slots: 'Which meals do you need?',
  slot_lunch: 'Lunch', slot_dinner: 'Dinner', slot_both: 'Both',
  ask_diet: 'Veg, non-veg or Jain?',
  diet_veg: 'Veg', diet_nonveg: 'Non-veg', diet_jain: 'Jain',
  ask_budget: 'What is your budget per meal?', budget_button: 'Choose',
  budget_60: 'Up to ₹60', budget_80: '₹60 – ₹80', budget_100: '₹80 – ₹100', budget_more: 'Above ₹100', budget_any: 'Any',
  ask_start: 'When do you want to start?',
  start_tomorrow: 'Tomorrow', start_week: 'This week', start_later: 'Just looking',
  matches: 'Here are kitchens near {area} with space for you:\n\n{lines}\n\nPick one to start a paid trial. You pay the kitchen directly; unused meals are refunded.',
  match_line: '*{name}* · {price}/meal · {km} km · {rating}\n{url}',
  new_kitchen: 'New',
  pick_button: 'Pick a kitchen',
  waitlist: 'Sorry, no kitchen near {area} has space right now. We have noted your request and will WhatsApp you as soon as one does. Reply *CHANGE* to try another area.',
  chosen: 'Great choice! 🎉 *{kitchen}* ({plan}).\nTrial: *{meals} meals for {amount}*. Pay here to start: {url}\n\nUnused meals are refunded pro-rata and there are no hidden charges. After you pay, this chat connects you to the kitchen.',
  restart: 'Sure, let us start again.',
  vendor_hello: 'Namaskar{name}! 🙏 Tiffin OS is *free software* for tiffin and mess owners: daily counts, pause/skip on WhatsApp, payments to your own account, a rider app — and we send you new customers.\n\nWhat is your kitchen called?',
  vendor_area: 'Which area is your kitchen in? Share your location 📍 or type the area.',
  vendor_size: 'About how many tiffin customers do you have?',
  size_small: 'Under 20', size_mid: '20 – 100', size_big: 'More than 100',
  vendor_done: 'Thank you! 🙌 You can start right now: log in at {url} with this WhatsApp number and set up your kitchen in 5 minutes. Our team will also call you within a day to help.',
};
const hi: Dict = {
  welcome: 'नमस्कार{name}! 🍱 घर जैसा टिफिन ढूँढ रहे हैं? मैं एक मिनट में पास के भरोसेमंद किचन दिखा सकता हूँ।',
  ask_location: 'कृपया अपनी *लोकेशन भेजें* 📍 (+ या 📎 → Location), या अपना इलाका लिखें, जैसे *Patia* या *Saheed Nagar*।',
  area_unknown: 'माफ़ कीजिए, यह इलाका नहीं मिला। लोकेशन 📍 भेजें या पास का इलाका लिखें, जैसे Patia, Infocity, Saheed Nagar।',
  ask_slots: 'कौन सा खाना चाहिए?', slot_lunch: 'दोपहर', slot_dinner: 'रात', slot_both: 'दोनों',
  ask_diet: 'शाकाहारी, मांसाहारी या जैन?', diet_veg: 'शाकाहारी', diet_nonveg: 'मांसाहारी', diet_jain: 'जैन',
  ask_budget: 'एक खाने का बजट कितना है?', budget_button: 'चुनें',
  budget_60: '₹60 तक', budget_80: '₹60 – ₹80', budget_100: '₹80 – ₹100', budget_more: '₹100 से ज़्यादा', budget_any: 'कोई भी',
  ask_start: 'कब से शुरू करना है?', start_tomorrow: 'कल से', start_week: 'इस हफ़्ते', start_later: 'बस देख रहे',
  matches: '{area} के पास ये किचन आपके लिए खाली हैं:\n\n{lines}\n\nपेड ट्रायल शुरू करने के लिए एक चुनें। भुगतान सीधे किचन को; बचे खानों का पैसा वापस।',
  match_line: '*{name}* · {price}/खाना · {km} km · {rating}\n{url}', new_kitchen: 'नया', pick_button: 'किचन चुनें',
  waitlist: 'माफ़ कीजिए, अभी {area} के पास किसी किचन में जगह नहीं है। जगह होते ही हम WhatsApp करेंगे। दूसरा इलाका आज़माने के लिए *CHANGE* लिखें।',
  chosen: 'बढ़िया! 🎉 *{kitchen}* ({plan})।\nट्रायल: *{meals} खाने {amount} में*। शुरू करने के लिए यहाँ भुगतान करें: {url}\n\nबचे खानों का पैसा वापस, कोई छिपा चार्ज नहीं। भुगतान के बाद यह चैट किचन से जुड़ जाएगी।',
  restart: 'ठीक है, फिर से शुरू करते हैं।',
  vendor_hello: 'नमस्कार{name}! 🙏 Tiffin OS टिफिन/मेस चलाने वालों के लिए *मुफ़्त सॉफ़्टवेयर* है: रोज़ की गिनती, WhatsApp पर पॉज़/स्किप, आपके खाते में भुगतान, राइडर ऐप — और हम नए ग्राहक भेजते हैं।\n\nआपके किचन का नाम क्या है?',
  vendor_area: 'आपका किचन किस इलाके में है? लोकेशन 📍 भेजें या इलाका लिखें।',
  vendor_size: 'लगभग कितने टिफिन ग्राहक हैं?', size_small: '20 से कम', size_mid: '20 – 100', size_big: '100 से ज़्यादा',
  vendor_done: 'धन्यवाद! 🙌 अभी शुरू करें: इसी WhatsApp नंबर से {url} पर लॉग इन करें और 5 मिनट में किचन सेट करें। हमारी टीम एक दिन में कॉल भी करेगी।',
};
const or: Dict = {
  welcome: 'ନମସ୍କାର{name}! 🍱 ଘର ପରି ଟିଫିନ୍ ଖୋଜୁଛନ୍ତି? ମୁଁ ଏକ ମିନିଟରେ ପାଖର ଭରସାଯୋଗ୍ୟ କିଚେନ୍ ଦେଖାଇପାରିବି।',
  ask_location: 'ଦୟାକରି ଆପଣଙ୍କ *ଲୋକେସନ୍ ପଠାନ୍ତୁ* 📍 (+ ବା 📎 → Location), କିମ୍ବା ଅଞ୍ଚଳ ଲେଖନ୍ତୁ, ଯେପରି *Patia* ବା *Saheed Nagar*।',
  area_unknown: 'କ୍ଷମା କରିବେ, ଏହି ଅଞ୍ଚଳ ମିଳିଲା ନାହିଁ। ଲୋକେସନ୍ 📍 ପଠାନ୍ତୁ ବା ପାଖ ଅଞ୍ଚଳ ଲେଖନ୍ତୁ, ଯେପରି Patia, Infocity, Saheed Nagar।',
  ask_slots: 'କେଉଁ ଖାଇବା ଦରକାର?', slot_lunch: 'ମଧ୍ୟାହ୍ନ', slot_dinner: 'ରାତି', slot_both: 'ଦୁଇଟି',
  ask_diet: 'ନିରାମିଷ, ଆମିଷ ବା ଜୈନ?', diet_veg: 'ନିରାମିଷ', diet_nonveg: 'ଆମିଷ', diet_jain: 'ଜୈନ',
  ask_budget: 'ଗୋଟିଏ ଖାଇବାର ବଜେଟ୍ କେତେ?', budget_button: 'ବାଛନ୍ତୁ',
  budget_60: '₹60 ପର୍ଯ୍ୟନ୍ତ', budget_80: '₹60 – ₹80', budget_100: '₹80 – ₹100', budget_more: '₹100 ରୁ ଅଧିକ', budget_any: 'ଯେକୌଣସି',
  ask_start: 'କେବେଠାରୁ ଆରମ୍ଭ କରିବେ?', start_tomorrow: 'କାଲିଠାରୁ', start_week: 'ଏହି ସପ୍ତାହ', start_later: 'କେବଳ ଦେଖୁଛି',
  matches: '{area} ପାଖରେ ଏହି କିଚେନ୍‌ରେ ଆପଣଙ୍କ ପାଇଁ ଜାଗା ଅଛି:\n\n{lines}\n\nପେଡ୍ ଟ୍ରାଏଲ୍ ପାଇଁ ଗୋଟିଏ ବାଛନ୍ତୁ। ପେମେଣ୍ଟ ସିଧା କିଚେନ୍‌କୁ; ବାକି ଖାଇବାର ଟଙ୍କା ଫେରସ୍ତ।',
  match_line: '*{name}* · {price}/ଖାଇବା · {km} km · {rating}\n{url}', new_kitchen: 'ନୂଆ', pick_button: 'କିଚେନ୍ ବାଛନ୍ତୁ',
  waitlist: 'କ୍ଷମା କରିବେ, ଏବେ {area} ପାଖରେ କୌଣସି କିଚେନ୍‌ରେ ଜାଗା ନାହିଁ। ଜାଗା ହେଲେ ଆମେ WhatsApp କରିବୁ। ଅନ୍ୟ ଅଞ୍ଚଳ ପାଇଁ *CHANGE* ଲେଖନ୍ତୁ।',
  chosen: 'ବଢ଼ିଆ! 🎉 *{kitchen}* ({plan})।\nଟ୍ରାଏଲ୍: *{meals}ଟି ଖାଇବା {amount}ରେ*। ଆରମ୍ଭ ପାଇଁ ଏଠାରେ ପେମେଣ୍ଟ କରନ୍ତୁ: {url}\n\nବାକି ଖାଇବାର ଟଙ୍କା ଫେରସ୍ତ, କୌଣସି ଲୁକ୍କାୟିତ ଚାର୍ଜ ନାହିଁ। ପେମେଣ୍ଟ ପରେ ଏହି ଚାଟ୍ କିଚେନ୍ ସହ ଯୋଡ଼ିହେବ।',
  restart: 'ଠିକ୍ ଅଛି, ପୁଣି ଆରମ୍ଭ କରିବା।',
  vendor_hello: 'ନମସ୍କାର{name}! 🙏 Tiffin OS ଟିଫିନ୍/ମେସ୍ ମାଲିକଙ୍କ ପାଇଁ *ମାଗଣା ସଫ୍ଟୱେର୍*: ଦୈନିକ ଗଣନା, WhatsApp‌ରେ ପଜ୍/ସ୍କିପ୍, ଆପଣଙ୍କ ଆକାଉଣ୍ଟକୁ ପେମେଣ୍ଟ, ରାଇଡର୍ ଆପ୍ — ଆଉ ଆମେ ନୂଆ ଗ୍ରାହକ ପଠାଉ।\n\nଆପଣଙ୍କ କିଚେନ୍‌ର ନାମ କ’ଣ?',
  vendor_area: 'ଆପଣଙ୍କ କିଚେନ୍ କେଉଁ ଅଞ୍ଚଳରେ? ଲୋକେସନ୍ 📍 ପଠାନ୍ତୁ ବା ଅଞ୍ଚଳ ଲେଖନ୍ତୁ।',
  vendor_size: 'ପାଖାପାଖି କେତେ ଟିଫିନ୍ ଗ୍ରାହକ ଅଛନ୍ତି?', size_small: '20 ରୁ କମ୍', size_mid: '20 – 100', size_big: '100 ରୁ ଅଧିକ',
  vendor_done: 'ଧନ୍ୟବାଦ! 🙌 ଏବେ ଆରମ୍ଭ କରନ୍ତୁ: ଏହି WhatsApp ନମ୍ବରରେ {url}ରେ ଲଗଇନ୍ କରି 5 ମିନିଟରେ କିଚେନ୍ ସେଟ୍ କରନ୍ତୁ। ଆମ ଟିମ୍ ଏକ ଦିନ ଭିତରେ କଲ୍ ବି କରିବ।',
};
const DICTS: Record<Lang, Dict> = { en, hi, or };

export function lt(lang: Lang, key: string, vars: Record<string, string | number> = {}): string {
  let s = DICTS[lang]?.[key] ?? en[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function detectLanguage(text: string): Lang | null {
  if (/[଀-୿]/.test(text)) return 'or';
  if (/[ऀ-ॿ]/.test(text)) return 'hi';
  return null;
}

/** "Hi TIFFIN ig-oct" / "Hi VENDOR ig-vendors" from campaign links. */
export function parseEntry(text: string): { vendor: boolean; campaign: string | null; source: string } {
  const t = text.trim().toLowerCase();
  const vendor = /\bvendor\b|kitchen owner|tiffin owner|mess owner|join as (a )?kitchen|register (my )?kitchen|tiffin service chala/.test(t);
  const m = /\b(?:tiffin|vendor)\s+([a-z0-9][a-z0-9-]{1,40})\b/.exec(t);
  const campaign = m && !['near', 'service', 'please', 'chahiye'].includes(m[1]!) ? m[1]! : null;
  const prefix = campaign?.split('-')[0] ?? '';
  const source = ({ ig: 'instagram', fb: 'instagram', gads: 'google_ads', web: 'website', jd: 'justdial', ref: 'referral' } as Record<string, string>)[prefix] ?? 'whatsapp';
  return { vendor, campaign, source };
}

type Step = 'location' | 'slots' | 'diet' | 'budget' | 'start' | 'matched';

/** The first question the lead hasn't answered (steps already filled from a web/ads form are skipped). */
const ORDER = ['location', 'slots', 'diet', 'budget', 'budget_done', 'start', 'matched'];
export function nextStep(l: Lead): Step {
  const at = ORDER.indexOf(l.bot_step ?? '');
  if (l.lat == null) return 'location';
  if (!l.slots?.length) return 'slots';
  if (!l.diet) return 'diet';
  // Budget is optional ("Any"): asked once, unless a form already gave it.
  if (l.budget_per_meal_paise == null && at <= ORDER.indexOf('budget')) return 'budget';
  if (!l.start_date && at < ORDER.indexOf('matched')) return 'start';
  return 'matched';
}

function ask(step: Step, lang: Lang): Out {
  switch (step) {
    case 'location':
      return { type: 'text', text: lt(lang, 'ask_location') };
    case 'slots':
      return { type: 'buttons', text: lt(lang, 'ask_slots'), buttons: [
        { id: 'l_slots|lunch', title: lt(lang, 'slot_lunch') }, { id: 'l_slots|dinner', title: lt(lang, 'slot_dinner') },
        { id: 'l_slots|both', title: lt(lang, 'slot_both') }] };
    case 'diet':
      return { type: 'buttons', text: lt(lang, 'ask_diet'), buttons: [
        { id: 'l_diet|veg', title: lt(lang, 'diet_veg') }, { id: 'l_diet|nonveg', title: lt(lang, 'diet_nonveg') },
        { id: 'l_diet|jain', title: lt(lang, 'diet_jain') }] };
    case 'budget':
      return { type: 'list', text: lt(lang, 'ask_budget'), button: lt(lang, 'budget_button'), rows: [
        { id: 'l_budget|5500', title: lt(lang, 'budget_60') }, { id: 'l_budget|7000', title: lt(lang, 'budget_80') },
        { id: 'l_budget|9000', title: lt(lang, 'budget_100') }, { id: 'l_budget|11000', title: lt(lang, 'budget_more') },
        { id: 'l_budget|any', title: lt(lang, 'budget_any') }] };
    case 'start':
      return { type: 'buttons', text: lt(lang, 'ask_start'), buttons: [
        { id: 'l_start|tomorrow', title: lt(lang, 'start_tomorrow') }, { id: 'l_start|week', title: lt(lang, 'start_week') },
        { id: 'l_start|later', title: lt(lang, 'start_later') }] };
    case 'matched':
      return { type: 'text', text: '' };
  }
}

export function shortlistReplies(l: Lead): Out[] {
  const lang = l.language;
  const area = l.area ?? 'you';
  if (!l.kitchens.length) return [{ type: 'text', text: lt(lang, 'waitlist', { area }) }];
  const lines = l.kitchens.map((k) => lt(lang, 'match_line', {
    name: k.name, price: rupees(k.price_per_meal_paise), km: k.distance_km,
    rating: k.rating != null ? `★${Number(k.rating).toFixed(1)} (${k.reviews})` : lt(lang, 'new_kitchen'), url: k.profile_url,
  })).join('\n\n');
  return [
    { type: 'text', text: lt(lang, 'matches', { area, lines }) },
    { type: 'list', text: lt(lang, 'pick_button'), button: lt(lang, 'pick_button'), rows: l.kitchens.map((k) => ({
      id: `l_pick|${k.kitchen_id}`, title: clip(k.name, 24),
      description: clip(`${rupees(k.price_per_meal_paise)}/meal · ${k.distance_km} km${k.rating != null ? ` · ★${Number(k.rating).toFixed(1)}` : ''}`, 72),
    })) },
  ];
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** One inbound message from a lead → replies. */
export async function handleLeadMessage(
  input: Inbound, lead: Lead, deps: LeadDeps, opts: { contactName?: string | null } = {},
): Promise<{ replies: Out[]; intent: string }> {
  const text = input.kind === 'text' ? input.text.trim() : '';
  const lower = text.toLowerCase();
  let l = lead;
  const detected = text ? detectLanguage(text) : null;
  if (detected && detected !== l.language) l = await deps.update({ language: detected }, l.bot_step);
  const lang = l.language;

  if (/^(restart|change|start over|reset)$/i.test(lower)) {
    l = await deps.update({}, 'location');
    return { replies: [{ type: 'text', text: lt(lang, 'restart') }, ask('location', lang)], intent: 'lead_restart' };
  }

  // Picking a kitchen from the shortlist.
  if (input.kind === 'reply' && input.id.startsWith('l_pick|')) {
    const c = await deps.choose(input.id.split('|')[1]!);
    return { replies: [{ type: 'text', text: lt(lang, 'chosen', {
      kitchen: c.kitchen_name, plan: c.plan_name, meals: c.trial_meals, amount: rupees(c.trial_amount_paise), url: c.portal_url,
    }) }], intent: 'lead_chose' };
  }

  // First contact: greet, then the first open question.
  if (!l.bot_step) {
    const step = nextStep(l);
    const name = opts.contactName ? ` ${opts.contactName.split(' ')[0]}` : '';
    if (step === 'matched') {
      l = await deps.update({}, 'matched');
      return { replies: [{ type: 'text', text: lt(lang, 'welcome', { name }) }, ...shortlistReplies(l)], intent: 'lead_matched' };
    }
    await deps.update({}, step);
    return { replies: [{ type: 'text', text: lt(lang, 'welcome', { name }) }, ask(step, lang)], intent: 'lead_greet' };
  }

  // Answer to the current question.
  const step = (ORDER.includes(l.bot_step ?? '') && l.bot_step !== 'budget_done' ? l.bot_step : nextStep(l)) as Step;
  const fields: Record<string, unknown> = {};
  let answered = false;
  switch (step) {
    case 'location':
      if (input.kind === 'location') { fields.lat = input.lat; fields.lng = input.lng; if (input.name) fields.address_text = input.name; answered = true; }
      else if (text) { fields.area = text; answered = true; }
      break;
    case 'slots': {
      const v = input.kind === 'reply' && input.id.startsWith('l_slots|') ? input.id.split('|')[1]
        : /both|dono|dui|ଦୁଇ|दोनों/.test(lower) ? 'both' : /dinner|night|raat|रात|ରାତି/.test(lower) ? 'dinner' : /lunch|day|din|दोपहर|ମଧ୍ୟାହ୍ନ/.test(lower) ? 'lunch' : null;
      if (v) { fields.slots = v === 'both' ? ['lunch', 'dinner'] : [v]; answered = true; }
      break;
    }
    case 'diet': {
      const v = input.kind === 'reply' && input.id.startsWith('l_diet|') ? input.id.split('|')[1]
        : /jain|जैन|ଜୈନ/.test(lower) ? 'jain' : /non|chicken|fish|egg|mutton|मांसाहारी|ଆମିଷ/.test(lower) ? 'nonveg' : /veg|शाकाहारी|ନିରାମିଷ/.test(lower) ? 'veg' : null;
      if (v) { fields.diet = v; answered = true; }
      break;
    }
    case 'budget': {
      const v = input.kind === 'reply' && input.id.startsWith('l_budget|') ? input.id.split('|')[1]
        : /\d+/.exec(lower)?.[0] ?? (/any|koi bhi/.test(lower) ? 'any' : null);
      if (v) {
        const n = v === 'any' ? null : Number(v) < 1000 ? Number(v) * 100 : Number(v);
        if (n == null || (n >= 2000 && n <= 50000)) { if (n != null) fields.budget_per_meal_paise = n; answered = true; }
      }
      break;
    }
    case 'start': {
      const v = input.kind === 'reply' && input.id.startsWith('l_start|') ? input.id.split('|')[1]
        : /tomorrow|kal|କାଲି/.test(lower) ? 'tomorrow' : /week|hafte|ସପ୍ତାହ/.test(lower) ? 'week' : text ? 'later' : null;
      if (v) {
        fields.start_date = addDays(deps.today, v === 'tomorrow' ? 1 : v === 'week' ? 3 : 7);
        if (v === 'later') fields.notes = 'Just looking';
        answered = true;
      }
      break;
    }
    case 'matched':
      // Capacity changes: match again (a chosen lead keeps its kitchen).
      l = await deps.update({}, 'matched');
      return { replies: shortlistReplies(l), intent: l.kitchens.length ? 'lead_matched' : 'lead_waitlist' };
  }

  if (!answered) return { replies: [ask(step, lang)], intent: 'lead_reask' };

  // Save, then ask the next open question (or match).
  const marker = step === 'budget' ? 'budget_done' : step;
  l = await deps.update(fields, marker);
  if (step === 'location' && l.lat == null) {
    return { replies: [{ type: 'text', text: lt(lang, 'area_unknown') }], intent: 'lead_area_unknown' };
  }
  const next = nextStep({ ...l, bot_step: marker });
  if (next === 'matched') {
    l = await deps.update({}, 'matched');
    return { replies: shortlistReplies(l), intent: l.kitchens.length ? 'lead_matched' : 'lead_waitlist' };
  }
  await deps.update({}, next === 'budget' ? 'budget' : next);
  return { replies: [ask(next, lang)], intent: `lead_ask_${next}` };
}

/** Vendor sign-up conversation (state lives on the platform conversation). */
export async function handleVendorMessage(
  input: Inbound, state: VendorState | null, lang: Lang, deps: VendorDeps,
  opts: { contactName?: string | null; campaign?: string | null } = {},
): Promise<{ replies: Out[]; intent: string }> {
  const text = input.kind === 'text' ? input.text.trim() : '';
  if (!state) {
    // The campaign code only comes with the first message ("Hi VENDOR ig-…"): keep it.
    await deps.setState({ flow: 'vendor', step: 'v_kitchen', campaign: opts.campaign ?? null });
    const name = opts.contactName ? ` ${opts.contactName.split(' ')[0]}` : '';
    return { replies: [{ type: 'text', text: lt(lang, 'vendor_hello', { name }) }], intent: 'vendor_greet' };
  }
  if (state.step === 'v_kitchen') {
    if (!text) return { replies: [{ type: 'text', text: lt(lang, 'vendor_hello', { name: '' }) }], intent: 'vendor_reask' };
    await deps.setState({ ...state, step: 'v_area', kitchen_name: text.slice(0, 80) });
    return { replies: [{ type: 'text', text: lt(lang, 'vendor_area') }], intent: 'vendor_ask_area' };
  }
  if (state.step === 'v_area') {
    const area = input.kind === 'location' ? (input.name ?? `${input.lat.toFixed(4)},${input.lng.toFixed(4)}`) : text;
    if (!area) return { replies: [{ type: 'text', text: lt(lang, 'vendor_area') }], intent: 'vendor_reask' };
    await deps.setState({ ...state, step: 'v_size', area: area.slice(0, 80) });
    return { replies: [{ type: 'buttons', text: lt(lang, 'vendor_size'), buttons: [
      { id: 'v_size|10', title: lt(lang, 'size_small') }, { id: 'v_size|50', title: lt(lang, 'size_mid') },
      { id: 'v_size|150', title: lt(lang, 'size_big') }] }], intent: 'vendor_ask_size' };
  }
  const sizeId = input.kind === 'reply' && input.id.startsWith('v_size|') ? Number(input.id.split('|')[1]) : Number(/\d+/.exec(text)?.[0] ?? NaN);
  await deps.apply({ kitchen_name: state.kitchen_name ?? '', area: state.area ?? '', subscribers: Number.isFinite(sizeId) ? sizeId : null,
    campaign: state.campaign ?? null });
  await deps.setState({});
  return { replies: [{ type: 'text', text: lt(lang, 'vendor_done', { url: deps.signupUrl }) }], intent: 'vendor_applied' };
}
