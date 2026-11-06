// Web vendor app strings moved to keys so far (draft rollout D-130): the sidebar nav and the Today
// page only. Everything else on the web is still English literals (D-006). English is the source of
// truth; Odia and Hindi drafts are in or.ts and hi.ts. No browser or server imports (unit-tested).
export const WEB_EN = {
  'nav.today': 'Today',
  'nav.customers': 'Customers',
  'nav.sheet': 'Kitchen sheet',
  'nav.delivery': 'Delivery',
  'nav.deliver': 'Deliver',
  'nav.menu': 'Menu',
  'nav.inventory': 'Inventory',
  'nav.stockEntry': 'Stock entry',
  'nav.inbox': 'Inbox',
  'nav.money': 'Money',
  'nav.costs': 'Costs',
  'nav.insights': 'Insights',
  'nav.plans': 'Plans',
  'nav.settings': 'Kitchen settings',
  'nav.team': 'Team',
  'nav.admin': 'Admin',
  'nav.search': 'Search name, phone, area…',
  'nav.language': 'Language',
  'nav.languageDraft': 'Odia and Hindi are drafts, still being checked by a native speaker. Pages not translated yet stay in English.',
  'today.title': 'Today',
  'today.menu': 'Menu',
  'today.changes': 'Changes since last count',
  'today.customers': 'Customers',
  'today.active': 'Active subscriptions',
  'today.paused': '{n} paused',
  'today.addCustomer': 'Add customer',
  'today.import': 'Import',
} as const;

export type WebKey = keyof typeof WEB_EN;
