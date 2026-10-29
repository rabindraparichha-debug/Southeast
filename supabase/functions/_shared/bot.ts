// The WhatsApp bot: deterministic menu flows first, keyword intents next, then the guarded AI
// fallback, and the kitchen inbox for anything else. Pure logic: every side effect goes through
// BotDeps, so the flows are unit-tested without a database or WhatsApp.

import { t, type BotKey, type Lang } from './bot-i18n.ts';
import { askAi, needsHuman, type AiIntent, type Complete } from './ai.ts';
import type { Inbound, Out } from './whatsapp.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export type Change = { subscription_id: string; type: 'skip' | 'pause' | 'resume'; from: string; to?: string | null; slot?: string | null };
export type ChangeResult = { after_cutoff: boolean; affected: { date: string; slot: string; late: boolean; charged: boolean }[] };

export interface BotDeps {
  applyChange(c: Change, dryRun: boolean): Promise<ChangeResult>;
  handoff(reason: string): Promise<void>;
  complaint(category: string, description: string | null, photo: string | null): Promise<string>;
  setState(state: Json): Promise<void>;
  setLanguage(lang: Lang): Promise<void>;
  setOptIn(optIn: boolean): Promise<void>;
  pageUrl(): Promise<string>;
  paymentLink(meals: number): Promise<{ url: string; amountPaise: number; meals: number }>;
  addLocation(lat: number, lng: number, label?: string): Promise<void>;
  complete?: Complete;
}

export type BotResult = { replies: Out[]; intent: string; handledBy: 'bot' | 'ai' | 'none' };

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const dateLabel = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

const KEYWORDS: [string, RegExp][] = [
  ['cancel', /(cancel (my )?(subscription|tiffin|plan)|stop (the )?(service|tiffin)|unsubscribe|band kar(na|o) (tiffin|service))/i],
  ['greet', /^(hi+|hello|hey|namaste|namaskar|namaskara|start|help|menu options|ନମସ୍କାର|नमस्ते)\b/i],
  ['menu', /(menu|khana|khaana|what.*(lunch|dinner)|ମେନୁ|मेनू)/i],
  ['balance', /(balance|meals left|kitne (khane|meal)|ବାଲାନ୍ସ|बैलेंस)/i],
  ['skip', /(skip|nahi chahiye|no (lunch|dinner|tiffin)|ସ୍କିପ୍|स्किप)/i],
  ['pause', /(pause|holiday|going (home|out of town)|ବନ୍ଦ|रोक)/i],
  ['resume', /(resume|start again|restart|back from|ପୁଣି ଆରମ୍ଭ|फिर से शुरू)/i],
  ['pay', /\b(pay|payment|recharge|top ?up)\b|ପେମେଣ୍ଟ|भुगतान/i],
  ['address', /(address|location|new place|ଠିକଣା|पता)/i],
  ['complaint', /(complain|cold food|not good|stale|hair in|late again|ଅଭିଯୋଗ|शिकायत)/i],
  ['talk', /(talk to|call me|speak to|human|owner|manager)/i],
  ['language', /^(language|bhasha|ଭାଷା|भाषा)$/i],
  ['page', /(my page|my account|link)/i],
];

export function detectIntent(text: string): string | null {
  for (const [intent, re] of KEYWORDS) if (re.test(text.trim())) return intent;
  return null;
}

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------
function liveSubs(ctx: Json): Json[] {
  return (ctx.subscriptions ?? []).filter((s: Json) => ['active', 'low_balance', 'paused'].includes(s.status));
}
function openMeals(ctx: Json): Json[] {
  return (ctx.meals ?? []).filter((m: Json) => m.status === 'scheduled' && !m.locked);
}
function mealLabel(lang: Lang, m: { date: string; slot: string }) {
  return `${dateLabel(m.date)} ${t(lang, m.slot as BotKey)}`;
}
function firstOpenDate(ctx: Json): string | null {
  const open = (ctx.meals ?? []).find((m: Json) => m.open);
  return open?.date ?? null;
}

export function mainMenu(lang: Lang, ctx: Json, intro?: string): Out {
  const paused = liveSubs(ctx).some((s) => s.status === 'paused') || (ctx.meals ?? []).some((m: Json) => m.skip_reason === 'pause' && m.open);
  const rows = [
    { id: 'm:menu', title: t(lang, 'row_menu'), description: t(lang, 'row_menu_desc') },
    { id: 'm:balance', title: t(lang, 'row_balance') },
    { id: 'm:skip', title: t(lang, 'row_skip') },
    paused ? { id: 'm:resume', title: t(lang, 'row_resume') } : { id: 'm:pause', title: t(lang, 'row_pause') },
    { id: 'm:pay', title: t(lang, 'row_pay') },
    { id: 'm:address', title: t(lang, 'row_address') },
    { id: 'm:complaint', title: t(lang, 'row_complaint') },
    { id: 'm:talk', title: t(lang, 'row_talk') },
    { id: 'm:page', title: t(lang, 'row_page') },
    { id: 'm:lang', title: t(lang, 'row_language') },
  ];
  return {
    type: 'list',
    text: intro ?? t(lang, 'greeting', { name: String(ctx.customer?.name ?? '').split(' ')[0] ?? '', kitchen: ctx.kitchen?.name ?? '' }),
    button: t(lang, 'menu_button'),
    rows,
  };
}

function menuFor(ctx: Json, date: string, slot: string): string | null {
  const m = (ctx.menus ?? []).find((x: Json) => x.date === date && x.slot === slot);
  return m?.dishes?.length ? m.dishes.join(', ') : null;
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------
async function runChanges(lang: Lang, deps: BotDeps, changes: Change[], kind: 'skip' | 'pause', extra?: Json): Promise<Out[]> {
  if (changes.length === 0) return [{ type: 'text', text: t(lang, 'nothing_to_skip') }];
  const previews = await Promise.all(changes.map((c) => deps.applyChange(c, true)));
  const charged = previews.flatMap((p) => p.affected.filter((a) => a.charged));
  if (charged.length > 0) {
    await deps.setState({ step: 'confirm', kind, changes, extra: extra ?? null });
    return [{
      type: 'buttons',
      text: t(lang, 'late_warning', { meals: charged.map((a) => mealLabel(lang, a)).join(', ') }),
      buttons: [{ id: 'c:yes', title: t(lang, 'confirm_yes') }, { id: 'c:no', title: t(lang, 'confirm_no') }],
    }];
  }
  return applyNow(lang, deps, changes, kind, extra);
}

async function applyNow(lang: Lang, deps: BotDeps, changes: Change[], kind: 'skip' | 'pause', extra?: Json): Promise<Out[]> {
  const results = [];
  for (const c of changes) results.push(await deps.applyChange(c, false));
  await deps.setState({});
  if (kind === 'pause') {
    const c = changes[0]!;
    return [{ type: 'text', text: t(lang, 'paused', { from: dateLabel(c.from), to: c.to ? t(lang, 'paused_until', { to: dateLabel(c.to) }) : '' }) }];
  }
  const affected = results.flatMap((r) => r.affected);
  const anyCharged = affected.some((a) => a.charged);
  const label = affected.length ? affected.map((a) => mealLabel(lang, a)).join(', ') : extra?.label ?? '';
  return [{ type: 'text', text: t(lang, anyCharged ? 'skipped_charged' : 'skipped', { meals: label }) }];
}

function skipDay(ctx: Json, date: string): Change[] {
  const subIds = new Set<string>((ctx.meals ?? []).filter((m: Json) => m.date === date && m.status === 'scheduled').map((m: Json) => m.subscription_id));
  return [...subIds].map((id) => ({ subscription_id: id, type: 'skip' as const, from: date, to: date }));
}

async function runMenuItem(item: string, lang: Lang, ctx: Json, deps: BotDeps): Promise<BotResult> {
  const kitchen = ctx.kitchen?.name ?? '';
  const done = (replies: Out[], intent = item): BotResult => ({ replies, intent, handledBy: 'bot' });

  switch (item) {
    case 'menu': {
      const days = [ctx.today, new Date(Date.parse(`${ctx.today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)];
      const text = days.map((d) => t(lang, 'menu_today', {
        date: dateLabel(d),
        lunch: menuFor(ctx, d, 'lunch') ?? t(lang, 'menu_none'),
        dinner: menuFor(ctx, d, 'dinner') ?? t(lang, 'menu_none'),
      })).join('\n\n');
      return done([{ type: 'buttons', text, buttons: [{ id: 'm:week', title: t(lang, 'menu_week_button') }, { id: 'm:skip', title: t(lang, 'row_skip') }] }]);
    }
    case 'week': {
      const byDate = new Map<string, string[]>();
      const off: number[] = ctx.kitchen?.weekly_off ?? [];
      for (const m of ctx.menus ?? []) {
        const dow = new Date(`${m.date}T00:00:00Z`).getUTCDay() || 7;
        if (off.includes(dow)) continue;
        const line = `${t(lang, m.slot as BotKey)}: ${m.dishes.join(', ')}`;
        byDate.set(m.date, [...(byDate.get(m.date) ?? []), line]);
      }
      const text = byDate.size
        ? `*${t(lang, 'menu_week_title')}*\n\n` + [...byDate.entries()].map(([d, lines]) => `*${dateLabel(d)}*\n${lines.join('\n')}`).join('\n\n')
        : t(lang, 'menu_none');
      return done([{ type: 'text', text }]);
    }
    case 'balance': {
      const b = ctx.balance ?? {};
      const parts = [b.meals < 0 ? t(lang, 'balance_owes', { meals: -b.meals }) : t(lang, 'balance', { meals: b.meals, value: rupees(b.value_paise ?? 0) })];
      if (liveSubs(ctx).length === 0 && (ctx.subscriptions ?? []).some((s: Json) => s.status === 'suspended')) parts.push(t(lang, 'balance_suspended'));
      else if (b.meals >= 0 && b.meals <= (b.low_threshold ?? 3)) parts.push(t(lang, 'balance_low'));
      const next = (ctx.meals ?? []).find((m: Json) => m.status !== 'skipped');
      if (next) parts.push(t(lang, 'next_meal', { meal: mealLabel(lang, next) }));
      const out: Out = b.meals <= (b.low_threshold ?? 3)
        ? { type: 'buttons', text: parts.join(' '), buttons: [{ id: 'm:pay', title: t(lang, 'pay_button') }] }
        : { type: 'text', text: parts.join(' ') };
      return done([out]);
    }
    case 'skip': {
      const meals = openMeals(ctx);
      if (meals.length === 0) return done([{ type: 'text', text: t(lang, 'nothing_to_skip') }]);
      const firstDate = meals[0]!.date;
      const rows = meals.slice(0, 8).map((m: Json) => ({ id: `skip|${m.subscription_id}|${m.date}|${m.slot}`, title: mealLabel(lang, m as { date: string; slot: string }) }));
      if (meals.filter((m: Json) => m.date === firstDate).length > 1) rows.unshift({ id: `skipday|${firstDate}`, title: t(lang, 'skip_day', { date: dateLabel(firstDate) }) });
      return done([{ type: 'list', text: t(lang, 'skip_pick'), button: t(lang, 'skip_pick_button'), rows: rows.slice(0, 10) }]);
    }
    case 'pause': {
      const from = firstOpenDate(ctx);
      if (!from || liveSubs(ctx).length === 0) return done([{ type: 'text', text: t(lang, 'nothing_to_skip') }]);
      return done([{
        type: 'buttons', text: t(lang, 'pause_pick', { date: dateLabel(from) }),
        buttons: [{ id: `pause|${from}|3`, title: t(lang, 'pause_3') }, { id: `pause|${from}|7`, title: t(lang, 'pause_7') }, { id: `pause|${from}|open`, title: t(lang, 'pause_open') }],
      }]);
    }
    case 'resume': {
      const held = (ctx.meals ?? []).filter((m: Json) => m.status === 'skipped' && m.open);
      if (held.length === 0 && !liveSubs(ctx).some((s) => s.status === 'paused')) return done([{ type: 'text', text: t(lang, 'nothing_to_resume') }]);
      const from = held[0]?.date ?? firstOpenDate(ctx) ?? ctx.today;
      for (const s of liveSubs(ctx)) await deps.applyChange({ subscription_id: s.id, type: 'resume', from }, false);
      return done([{ type: 'text', text: t(lang, 'resumed', { date: dateLabel(from) }) }]);
    }
    case 'pay': {
      if (!ctx.kitchen?.online_payments) return done([{ type: 'text', text: t(lang, 'pay_offline', { kitchen }) }]);
      const price = liveSubs(ctx)[0]?.price_paise ?? (ctx.subscriptions ?? [])[0]?.price_paise;
      if (!price) return done([{ type: 'text', text: t(lang, 'pay_offline', { kitchen }) }]);
      return done([{
        type: 'buttons', text: t(lang, 'pay_pick'),
        buttons: [10, 26, 30].map((n) => ({ id: `pay|${n}`, title: t(lang, 'pay_meals', { meals: n, amount: rupees(n * price) }) })),
      }]);
    }
    case 'address': {
      await deps.setState({ step: 'address' });
      return done([{ type: 'text', text: t(lang, 'address_ask', { url: await deps.pageUrl() }) }]);
    }
    case 'complaint': {
      const cats = ['late', 'quality', 'quantity', 'missing', 'hygiene', 'delivery', 'billing', 'other'];
      return done([{
        type: 'list', text: t(lang, 'complaint_pick'), button: t(lang, 'complaint_button'),
        rows: cats.map((c) => ({ id: `cmp|${c}`, title: t(lang, `cmp_${c}` as BotKey) })),
      }]);
    }
    case 'talk': {
      await deps.handoff('customer asked to talk');
      return done([{ type: 'text', text: t(lang, 'talk', { kitchen }) }]);
    }
    case 'page':
      return done([{ type: 'text', text: t(lang, 'page', { url: await deps.pageUrl() }) }]);
    case 'lang':
      return done([{
        type: 'buttons', text: t(lang, 'language_pick'),
        buttons: [{ id: 'lang|or', title: 'ଓଡ଼ିଆ' }, { id: 'lang|hi', title: 'हिंदी' }, { id: 'lang|en', title: 'English' }],
      }]);
    default:
      return done([mainMenu(lang, ctx)], 'greet');
  }
}

async function handleReply(id: string, lang: Lang, ctx: Json, deps: BotDeps): Promise<BotResult> {
  const [head, ...rest] = id.split('|');
  const done = (replies: Out[], intent: string): BotResult => ({ replies, intent, handledBy: 'bot' });

  if (head!.startsWith('m:')) return runMenuItem(head!.slice(2), lang, ctx, deps);
  if (id === 'c:yes' || id === 'c:no') {
    const st = ctx.state ?? {};
    if (id === 'c:yes' && st.step === 'confirm') {
      return done(await applyNow(lang, deps, st.changes as Change[], st.kind, st.extra ?? undefined), st.kind);
    }
    await deps.setState({});
    return done([{ type: 'text', text: t(lang, 'kept') }], 'keep');
  }
  switch (head) {
    case 'skip': {
      const [sub, date, slot] = rest;
      return done(await runChanges(lang, deps, [{ subscription_id: sub!, type: 'skip', from: date!, to: date!, slot: slot! }], 'skip'), 'skip');
    }
    case 'skipday':
    case 'nudge_skip':
      return done(await runChanges(lang, deps, skipDay(ctx, rest[0]!), 'skip', { label: dateLabel(rest[0]!) }), 'skip');
    case 'nudge_keep':
      return done([{ type: 'text', text: t(lang, 'nudge_keep') }], 'keep');
    case 'pause': {
      const [from, len] = rest;
      const to = len === 'open' ? null : new Date(Date.parse(`${from}T00:00:00Z`) + (Number(len) - 1) * 86_400_000).toISOString().slice(0, 10);
      const changes = liveSubs(ctx).map((s) => ({ subscription_id: s.id, type: 'pause' as const, from: from!, to }));
      return done(await runChanges(lang, deps, changes, 'pause'), 'pause');
    }
    case 'pay': {
      const link = await deps.paymentLink(Number(rest[0]));
      return done([{ type: 'text', text: t(lang, 'pay_link', { amount: rupees(link.amountPaise), meals: link.meals, url: link.url, terms: t(lang, 'pay_terms') }) }], 'pay');
    }
    case 'cmp':
      await deps.setState({ step: 'complaint', category: rest[0] });
      return done([{ type: 'buttons', text: t(lang, 'complaint_detail'), buttons: [{ id: 'cmpskip', title: t(lang, 'complaint_skip') }] }], 'complaint');
    case 'cmpskip':
      return done(await fileComplaint(lang, ctx, deps, null, null), 'complaint');
    case 'lang': {
      const next = (['en', 'or', 'hi'].includes(rest[0]!) ? rest[0] : 'en') as Lang;
      await deps.setLanguage(next);
      return done([mainMenu(next, ctx, t(next, 'language_set'))], 'language');
    }
    case 'optin': {
      const yes = rest[0] === 'yes';
      await deps.setOptIn(yes);
      return done([{ type: 'text', text: t(lang, yes ? 'optin_saved_yes' : 'optin_saved_no') }], 'optin');
    }
    default:
      return done([mainMenu(lang, ctx, t(lang, 'didnt_get'))], 'unknown');
  }
}

async function fileComplaint(lang: Lang, ctx: Json, deps: BotDeps, description: string | null, photo: string | null): Promise<Out[]> {
  const category = ctx.state?.category ?? 'other';
  const id = await deps.complaint(category, description, photo);
  await deps.setState({});
  return [{ type: 'text', text: t(lang, 'complaint_logged', { ref: id.slice(0, 6).toUpperCase(), kitchen: ctx.kitchen?.name ?? '' }) }];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export async function handleMessage(input: Inbound, ctx: Json, rawDeps: BotDeps): Promise<BotResult> {
  const lang = (ctx.language ?? 'en') as Lang;
  const kitchen = ctx.kitchen?.name ?? '';
  const state = ctx.state ?? {};
  let result: BotResult;
  // Flows replace the state; the opt-in flag must survive those writes.
  let latest: Json = { ...state };
  const deps: BotDeps = {
    ...rawDeps,
    setState: async (s: Json) => {
      latest = { ...s, ...(latest.optin_asked ? { optin_asked: true } : {}) };
      await rawDeps.setState(latest);
    },
  };

  if (input.kind === 'reply') {
    result = await handleReply(input.id, lang, ctx, deps);
  } else if (input.kind === 'location') {
    await deps.addLocation(input.lat, input.lng, input.name);
    await deps.setState({});
    result = { replies: [{ type: 'text', text: t(lang, 'address_saved') }], intent: 'address', handledBy: 'bot' };
  } else if (state.step === 'complaint' && (input.kind === 'text' || input.kind === 'image')) {
    result = {
      replies: await fileComplaint(lang, ctx, deps, input.kind === 'text' ? input.text : input.caption ?? null, input.kind === 'image' ? input.mediaId : null),
      intent: 'complaint', handledBy: 'bot',
    };
  } else if (input.kind === 'text') {
    const text = input.text.trim();
    // WhatsApp opt-out/in keywords work at any time, even while the kitchen is handling the chat.
    if (/^(stop|stop updates|stop messages|unsubscribe)\.?$/i.test(text)) {
      await deps.setOptIn(false);
      return { replies: [{ type: 'text', text: t(lang, 'optout_done') }], intent: 'optout', handledBy: 'bot' };
    }
    if (/^updates\.?$/i.test(text)) {
      await deps.setOptIn(true);
      return { replies: [{ type: 'text', text: t(lang, 'optin_saved_yes') }], intent: 'optin', handledBy: 'bot' };
    }
    const intent = detectIntent(text);
    if (ctx.handoff_open && intent !== 'greet' && intent !== 'menu') {
      // The kitchen is handling this conversation; stay quiet (message is in their inbox).
      return { replies: [], intent: 'handoff_message', handledBy: 'none' };
    }
    if (intent === 'cancel') {
      await deps.handoff('customer wants to stop the tiffin');
      result = { replies: [{ type: 'text', text: t(lang, 'cancel_request', { kitchen }) }], intent: 'cancel', handledBy: 'bot' };
    } else if (needsHuman(text)) {
      await deps.handoff('money question (discount/refund)');
      result = { replies: [{ type: 'text', text: t(lang, 'guarded', { kitchen }) }], intent: 'guarded', handledBy: 'bot' };
    } else if (intent) {
      result = await runMenuItem(intent === 'greet' ? 'greet' : intent === 'language' ? 'lang' : intent, lang, ctx, deps);
    } else {
      const ai = await askAi(text, ctx, lang, deps.complete);
      if (ai.handoff) {
        await deps.handoff('question for the kitchen');
        result = { replies: [{ type: 'text', text: t(lang, 'guarded', { kitchen }) }], intent: 'ai_handoff', handledBy: 'ai' };
      } else if (ai.intent !== 'answer' && ai.intent !== 'other') {
        result = { ...(await runMenuItem(ai.intent as Exclude<AiIntent, 'answer' | 'other'>, lang, ctx, deps)), handledBy: 'ai' };
      } else {
        result = { replies: [{ type: 'buttons', text: ai.reply, buttons: [{ id: 'm:menu', title: t(lang, 'row_menu') }, { id: 'm:talk', title: t(lang, 'row_talk') }] }], intent: 'ai_answer', handledBy: 'ai' };
      }
    }
  } else {
    result = { replies: [mainMenu(lang, ctx, t(lang, 'didnt_get'))], intent: 'unknown', handledBy: 'bot' };
  }

  // First contact without opt-in: ask once whether we may send updates.
  if (!ctx.opted_in && !state.optin_asked && result.replies.length > 0) {
    latest = { ...latest, optin_asked: true };
    await rawDeps.setState(latest);
    result.replies.push({
      type: 'buttons', text: t(lang, 'optin_ask'),
      buttons: [{ id: 'optin|yes', title: t(lang, 'optin_yes') }, { id: 'optin|no', title: t(lang, 'optin_no') }],
    });
  }
  return result;
}

export function unknownNumberReply(): Out {
  return { type: 'text', text: t('en', 'unknown_number') };
}

export function chooseKitchenReply(kitchens: { kitchen_id: string; kitchen_name: string }[]): Out {
  return {
    type: 'list', text: t('en', 'choose_kitchen'), button: t('en', 'menu_button'),
    rows: kitchens.slice(0, 10).map((k) => ({ id: `kitchen|${k.kitchen_id}`, title: k.kitchen_name })),
  };
}
