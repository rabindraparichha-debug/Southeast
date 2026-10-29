// Customer page labels. English is the source; Odia/Hindi are drafts pending native review (D-057).
export type Lang = 'en' | 'or' | 'hi';

const en = {
  balance: 'Meals left',
  owes: 'You owe {n} meals',
  prepaid: '{v} prepaid',
  pay: 'Pay for meals',
  pay_terms: 'Before you pay: one prepaid meal is used per tiffin. If you cancel, unused meals are refunded at the price you paid. Skips after the cutoff are charged. No other charges.',
  pay_offline: 'Pay your kitchen directly (cash or UPI).',
  upcoming: 'Upcoming meals',
  skip: 'Skip',
  skipped: 'Skipped',
  paused: 'Paused',
  locked: 'Being prepared',
  late_charged: 'Skipped late (charged)',
  undo: 'Undo',
  late_warning: 'This is past the cutoff, so it will still be charged. Skip anyway?',
  confirm: 'Yes, skip',
  cancel: 'No',
  pause_title: 'Going away?',
  pause_3: 'Pause 3 days',
  pause_7: 'Pause 1 week',
  pause_open: 'Pause until I resume',
  resume: 'Resume meals',
  menu: 'This week’s menu',
  address: 'Delivery address',
  add_address: 'Add a new address',
  deliver_here: 'Deliver here',
  save: 'Save',
  complaint: 'Report a problem',
  complaint_send: 'Send to kitchen',
  history: 'Payments and refunds',
  language: 'Language',
  grievance: 'Grievance contact',
  delete_data: 'Ask to delete my data',
  done: 'Done',
  stopping: 'To stop your tiffin, message your kitchen; unused meals are refunded at the price you paid.',
  // M7: verified kitchen reviews
  rate_title: 'Rate your kitchen',
  rate_comment: 'Anything to add? (optional)',
  rate_send: 'Send rating',
  rate_thanks: 'Thank you! Your rating helps other customers choose.',
  rate_note: 'Shown on the kitchen’s public page with your first name.',
  // M8: legal pages (English only for now)
  privacy: 'Privacy policy',
  terms: 'Terms of use',
};
export type Key = keyof typeof en;

const hi: Partial<Record<Key, string>> = {
  balance: 'बाकी खाने', owes: 'आप पर {n} खाने बाकी', prepaid: '{v} प्रीपेड', pay: 'खाने का भुगतान',
  pay_terms: 'भुगतान से पहले: हर टिफिन पर एक प्रीपेड खाना कटता है। बंद करने पर बचे खानों का पैसा उसी दाम पर वापस। कटऑफ के बाद स्किप का पैसा लगता है। कोई और शुल्क नहीं।',
  pay_offline: 'अपने किचन को सीधे भुगतान करें (कैश या UPI)।', upcoming: 'आने वाले खाने', skip: 'स्किप', skipped: 'स्किप किया',
  paused: 'रुका हुआ', locked: 'बन रहा है', late_charged: 'देर से स्किप (पैसा लगेगा)', undo: 'वापस लें',
  late_warning: 'कटऑफ निकल चुका है, पैसा फिर भी लगेगा। फिर भी स्किप करें?', confirm: 'हाँ, स्किप', cancel: 'नहीं',
  pause_title: 'बाहर जा रहे हैं?', pause_3: '3 दिन रोकें', pause_7: '1 हफ्ता रोकें', pause_open: 'जब तक न कहूँ', resume: 'फिर शुरू करें',
  menu: 'इस हफ्ते का मेनू', address: 'डिलीवरी का पता', add_address: 'नया पता जोड़ें', deliver_here: 'यहाँ भेजें', save: 'सेव करें',
  complaint: 'समस्या बताएँ', complaint_send: 'किचन को भेजें', history: 'भुगतान और रिफंड', language: 'भाषा',
  grievance: 'शिकायत अधिकारी', delete_data: 'मेरा डेटा हटाने का अनुरोध', done: 'हो गया',
  stopping: 'टिफिन बंद करने के लिए किचन को संदेश भेजें; बचे खानों का पैसा उसी दाम पर वापस मिलता है।',
  // M7 drafts (pending native review)
  rate_title: 'अपने किचन को रेटिंग दें', rate_comment: 'कुछ और कहना है? (वैकल्पिक)', rate_send: 'रेटिंग भेजें',
  rate_thanks: 'धन्यवाद! आपकी रेटिंग से दूसरे ग्राहकों को चुनने में मदद मिलती है।',
  rate_note: 'किचन के सार्वजनिक पेज पर आपके पहले नाम के साथ दिखेगी।',
  privacy: 'गोपनीयता नीति', terms: 'उपयोग की शर्तें',
};
const or: Partial<Record<Key, string>> = {
  balance: 'ବାକି ଖାଇବା', owes: 'ଆପଣଙ୍କ ଉପରେ {n}ଟି ଖାଇବା ବାକି', prepaid: '{v} ପ୍ରିପେଡ୍', pay: 'ଖାଇବା ପାଇଁ ପେମେଣ୍ଟ',
  pay_terms: 'ପେମେଣ୍ଟ ପୂର୍ବରୁ: ପ୍ରତି ଟିଫିନରେ ଗୋଟିଏ ପ୍ରିପେଡ୍ ଖାଇବା କଟେ। ବନ୍ଦ କଲେ ବାକି ଖାଇବାର ଟଙ୍କା ସେହି ଦରରେ ଫେରସ୍ତ। କଟଅଫ୍ ପରେ ସ୍କିପ୍ କଲେ ଟଙ୍କା ଲାଗେ। ଅନ୍ୟ କୌଣସି ଚାର୍ଜ ନାହିଁ।',
  pay_offline: 'ଆପଣଙ୍କ କିଚେନକୁ ସିଧା ପେମେଣ୍ଟ କରନ୍ତୁ (କ୍ୟାସ୍ କିମ୍ବା UPI)।', upcoming: 'ଆସୁଥିବା ଖାଇବା', skip: 'ସ୍କିପ୍', skipped: 'ସ୍କିପ୍ ହେଲା',
  paused: 'ବନ୍ଦ', locked: 'ତିଆରି ହେଉଛି', late_charged: 'ଡେରିରେ ସ୍କିପ୍ (ଟଙ୍କା ଲାଗିବ)', undo: 'ଫେରାନ୍ତୁ',
  late_warning: 'କଟଅଫ୍ ସମୟ ଚାଲିଗଲାଣି, ଟଙ୍କା ଲାଗିବ। ତଥାପି ସ୍କିପ୍ କରିବେ?', confirm: 'ହଁ, ସ୍କିପ୍', cancel: 'ନା',
  pause_title: 'ବାହାରକୁ ଯାଉଛନ୍ତି?', pause_3: '3 ଦିନ ବନ୍ଦ', pause_7: '1 ସପ୍ତାହ ବନ୍ଦ', pause_open: 'ମୁଁ କହିବା ପର୍ଯ୍ୟନ୍ତ', resume: 'ପୁଣି ଆରମ୍ଭ',
  menu: 'ଏହି ସପ୍ତାହର ମେନୁ', address: 'ଡେଲିଭରି ଠିକଣା', add_address: 'ନୂଆ ଠିକଣା', deliver_here: 'ଏଠାକୁ ପଠାନ୍ତୁ', save: 'ସେଭ୍',
  complaint: 'ସମସ୍ୟା ଜଣାନ୍ତୁ', complaint_send: 'କିଚେନକୁ ପଠାନ୍ତୁ', history: 'ପେମେଣ୍ଟ ଓ ରିଫଣ୍ଡ', language: 'ଭାଷା',
  grievance: 'ଅଭିଯୋଗ ଅଧିକାରୀ', delete_data: 'ମୋ ଡାଟା ହଟାଇବା ଅନୁରୋଧ', done: 'ହୋଇଗଲା',
  stopping: 'ଟିଫିନ ବନ୍ଦ କରିବାକୁ କିଚେନକୁ ମେସେଜ୍ କରନ୍ତୁ; ବାକି ଖାଇବାର ଟଙ୍କା ସେହି ଦରରେ ଫେରସ୍ତ।',
  // M7 drafts (pending native review)
  rate_title: 'ଆପଣଙ୍କ କିଚେନକୁ ରେଟିଂ ଦିଅନ୍ତୁ', rate_comment: 'ଆଉ କିଛି କହିବେ? (ଇଚ୍ଛାଧୀନ)', rate_send: 'ରେଟିଂ ପଠାନ୍ତୁ',
  rate_thanks: 'ଧନ୍ୟବାଦ! ଆପଣଙ୍କ ରେଟିଂ ଅନ୍ୟ ଗ୍ରାହକଙ୍କୁ ବାଛିବାରେ ସାହାଯ୍ୟ କରେ।',
  rate_note: 'କିଚେନର ସାର୍ବଜନୀନ ପେଜରେ ଆପଣଙ୍କ ପ୍ରଥମ ନାମ ସହ ଦେଖାଯିବ।',
  privacy: 'ଗୋପନୀୟତା ନୀତି', terms: 'ବ୍ୟବହାର ସର୍ତ୍ତାବଳୀ',
};
const dict: Record<Lang, Partial<Record<Key, string>>> = { en, hi, or };

export function tr(lang: Lang, key: Key, vars: Record<string, string | number> = {}) {
  let s = dict[lang]?.[key] ?? en[key];
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}
