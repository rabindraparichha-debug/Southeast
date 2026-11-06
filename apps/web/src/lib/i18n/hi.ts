// DRAFT — needs native speaker review (D-006)
// Hindi drafts for the web nav and Today page (draft rollout D-130). Placeholders in {braces} stay as
// in English; missing keys fall back to English.
import type { WebKey } from './en';

export const WEB_HI: Partial<Record<WebKey, string>> = {
  'nav.today': 'आज',
  'nav.customers': 'ग्राहक',
  'nav.sheet': 'किचन शीट',
  'nav.delivery': 'डिलीवरी',
  'nav.deliver': 'डिलीवर करें',
  'nav.menu': 'मेन्यू',
  'nav.inventory': 'सामान',
  'nav.stockEntry': 'स्टॉक एंट्री',
  'nav.inbox': 'इनबॉक्स',
  'nav.money': 'पैसे',
  'nav.costs': 'लागत',
  'nav.insights': 'जानकारी',
  'nav.plans': 'प्लान',
  'nav.settings': 'किचन सेटिंग्स',
  'nav.team': 'टीम',
  'nav.admin': 'एडमिन',
  'nav.search': 'नाम, फ़ोन, इलाक़ा खोजें…',
  'nav.language': 'भाषा',
  'nav.languageDraft': 'ओड़िया और हिंदी अभी ड्राफ़्ट हैं, एक मूल भाषी इनकी जाँच कर रहे हैं। जो पेज अभी अनुवादित नहीं हैं, वे अंग्रेज़ी में रहेंगे।',
  'today.title': 'आज',
  'today.menu': 'मेन्यू',
  'today.changes': 'पिछली गिनती के बाद के बदलाव',
  'today.customers': 'ग्राहक',
  'today.active': 'चालू सब्सक्रिप्शन',
  'today.paused': '{n} रुके हुए',
  'today.addCustomer': 'ग्राहक जोड़ें',
  'today.import': 'इम्पोर्ट',
};
