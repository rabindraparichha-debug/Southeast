'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { WEEKDAYS, formatPaise, formatServiceDate } from '@tiffin/core';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { healthLabel } from '@/lib/p5';
import type { Key } from './i18n';

// Customer page additions for P5/P6. Every call passes the page token; the RPCs check it.

type T = (k: Key, v?: Record<string, string | number>) => string;

export type Dependent = {
  customer_id: string; name: string; balance_meals: number; low_threshold: number | null;
  subscriptions: { id: string; status: string; plan: string; price_paise: number; slots: string[] }[];
};
export type FoodPrefs = { observes_veg_days: boolean; observes_kartika: boolean; kitchen_veg_days: number[]; kitchen_kartika_mode: boolean; kartika_now: boolean };
export type ReferralInfo = { code: string | null; url: string; reward_meals: number; referred: boolean; can_apply: boolean };
export type PortalSpecial = { service_date: string; slot: string; name: string; description: string | null; addon_price_paise: number | null };
export type PortalFestival = { name: string; starts_on: string; ends_on: string; kind: string; veg_only: boolean };
type SwitchOptions = {
  current: { plan_name: string; price_per_meal_paise: number };
  options: { kitchen_id: string; name: string; area: string | null; distance_km: number; plan_name: string; price_per_meal_paise: number; rating: number | null; reviews: number | null; profile_url: string }[];
  open_request: { id: string; kitchen_name: string; created_at: string } | null;
};

const card = 'rounded-2xl bg-white p-4 shadow-sm ring-1 ring-ink-100';
const btn = 'rounded-lg px-3 py-2 text-sm font-medium ring-1 ring-ink-200 bg-white active:bg-ink-50 disabled:opacity-50';
const SLOT: Record<string, string> = { lunch: 'Lunch', dinner: 'Dinner' };

function useCall() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function call<R>(fn: () => PromiseLike<{ data: R; error: { message: string; code?: string } | null }>, ok?: string): Promise<R | null> {
    setBusy(true);
    setMsg(null);
    const { data, error } = await fn();
    setBusy(false);
    if (error) {
      setMsg({ ok: false, text: error.message === 'invalid_link' ? 'This link has expired. Send “my page” on WhatsApp for a new one.' : friendlyError(error) });
      return null;
    }
    if (ok) setMsg({ ok: true, text: ok });
    router.refresh();
    return data;
  }
  const note = msg && <p role="status" className={`mt-2 text-sm ${msg.ok ? 'text-green-800' : 'text-red-700'}`}>{msg.text}</p>;
  return { busy, setBusy, call, note, setMsg };
}

export function DependentsCard({ token, dependents, onlinePayments, t }: { token: string; dependents: Dependent[]; onlinePayments: boolean; t: T }) {
  const { busy, setBusy, note, setMsg } = useCall();
  async function pay(dependentId: string, meals: number) {
    setBusy(true);
    setMsg(null);
    const { data, error } = await supabaseBrowser().functions.invoke('razorpay-payment-link', { body: { token, meals, dependent_id: dependentId } });
    setBusy(false);
    const url = (data as { short_url?: string } | null)?.short_url;
    if (error || !url) return setMsg({ ok: false, text: 'Payment is not available right now. Please pay your kitchen directly.' });
    window.location.assign(url);
  }
  return (
    <section className={card} data-testid="dependents">
      <h2 className="text-sm font-semibold">{t('dependents')}</h2>
      <p className="text-xs text-ink-500">{t('dependents_note')}</p>
      <ul className="mt-3 space-y-4">
        {dependents.map((d) => {
          const price = d.subscriptions.find((s) => ['active', 'low_balance', 'paused', 'trial'].includes(s.status))?.price_paise ?? d.subscriptions[0]?.price_paise;
          const low = d.balance_meals <= (d.low_threshold ?? 0);
          return (
            <li key={d.customer_id}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium">{d.name}</span>
                <span className={`text-sm ${d.balance_meals < 0 ? 'font-semibold text-red-700' : low ? 'text-amber-700' : 'text-ink-600'}`}>
                  {d.balance_meals < 0 ? t('owes_n', { n: -d.balance_meals }) : t('meals_left_n', { n: d.balance_meals })}{low && d.balance_meals >= 0 ? ` · ${t('low')}` : ''}
                </span>
              </div>
              {onlinePayments && price ? (
                <div className="mt-2 grid grid-cols-3 gap-2">
                  {[10, 26, 30].map((n) => (
                    <button key={n} disabled={busy} onClick={() => pay(d.customer_id, n)} className="rounded-lg bg-brand-600 px-2 py-2 text-sm font-medium text-white disabled:opacity-50">
                      {n} · {formatPaise(n * price)}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="mt-1 text-xs text-ink-500">{t('pay_offline')}</p>
              )}
            </li>
          );
        })}
      </ul>
      {note}
    </section>
  );
}

export function FoodPrefsCard({ token, prefs, t }: { token: string; prefs: FoodPrefs; t: T }) {
  const { busy, call, note } = useCall();
  const [v, setV] = useState({ veg: prefs.observes_veg_days, kartika: prefs.observes_kartika });
  const days = prefs.kitchen_veg_days.map((d) => WEEKDAYS[d - 1]?.short).filter(Boolean).join(', ');
  const hasVeg = prefs.kitchen_veg_days.length > 0;
  if (!hasVeg && !prefs.kitchen_kartika_mode) return null;
  async function save(next: { veg: boolean; kartika: boolean }) {
    setV(next);
    await call(() => supabaseBrowser().rpc('portal_set_food_prefs', { p_token: token, p_veg_days: next.veg, p_kartika: next.kartika }), t('done'));
  }
  return (
    <section className={card} data-testid="food-prefs">
      <h2 className="mb-2 text-sm font-semibold">{t('food_prefs')}</h2>
      <div className="space-y-2 text-sm">
        {hasVeg && (
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={v.veg} disabled={busy} onChange={(e) => save({ ...v, veg: e.target.checked })} data-testid="portal-veg-days" />
            <span>{t('veg_days_pref', { days })} {t('veg_days_festivals')}</span>
          </label>
        )}
        {prefs.kitchen_kartika_mode && (
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={v.kartika} disabled={busy} onChange={(e) => save({ ...v, kartika: e.target.checked })} data-testid="portal-kartika" />
            <span>{t('kartika_pref')}{prefs.kartika_now && <span className="block text-xs text-green-800">{t('kartika_now')}</span>}</span>
          </label>
        )}
        <p className="text-xs text-ink-500">{t('food_prefs_note')}</p>
      </div>
      {note}
    </section>
  );
}

export function SpecialsCard({ specials, festivals, t }: { specials: PortalSpecial[]; festivals: PortalFestival[]; t: T }) {
  if (!specials.length && !festivals.length) return null;
  return (
    <section className={card} data-testid="specials">
      {specials.length > 0 && (
        <>
          <h2 className="mb-2 text-sm font-semibold">{t('specials')}</h2>
          <ul className="mb-3 space-y-2 text-sm">
            {specials.map((s, i) => (
              <li key={i}>
                <span className="font-medium">{s.name}</span>
                <span className="text-ink-500"> · {formatServiceDate(s.service_date)} {SLOT[s.slot] ?? s.slot}{s.addon_price_paise ? ` · ${t('extra', { v: formatPaise(s.addon_price_paise) })}` : ''}</span>
                {s.description && <p className="text-xs text-ink-600">{s.description}</p>}
              </li>
            ))}
          </ul>
        </>
      )}
      {festivals.length > 0 && (
        <>
          <h2 className="mb-1 text-sm font-semibold">{t('festivals')}</h2>
          <ul className="space-y-1 text-sm">
            {festivals.map((f, i) => (
              <li key={i} className="flex justify-between gap-2">
                <span>{f.name}{f.veg_only ? ` · ${t('veg')}` : ''}</span>
                <span className="shrink-0 text-ink-500">{formatServiceDate(f.starts_on)}{f.ends_on !== f.starts_on ? ` – ${formatServiceDate(f.ends_on)}` : ''}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export function ReferralCardPortal({ token, referral, kitchenName, t }: { token: string; referral: ReferralInfo; kitchenName: string; t: T }) {
  const { busy, call, note } = useCall();
  const [code, setCode] = useState('');
  if (!referral.code) return null;
  const share = `https://wa.me/?text=${encodeURIComponent(t('refer_message', { kitchen: kitchenName, code: referral.code, url: referral.url }))}`;
  return (
    <section className={card} data-testid="referral">
      <h2 className="mb-1 text-sm font-semibold">{t('refer')}</h2>
      <p className="font-mono text-2xl font-semibold tracking-widest">{referral.code}</p>
      {referral.reward_meals > 0 && <p className="text-sm text-ink-600">{t('refer_reward', { n: referral.reward_meals })}</p>}
      <a href={share} target="_blank" rel="noreferrer" className="mt-2 inline-flex rounded-lg bg-green-600 px-3 py-2 text-sm font-medium text-white">{t('refer_share')}</a>
      {referral.can_apply && (
        <div className="mt-4 border-t border-ink-100 pt-3">
          <h3 className="text-sm font-medium">{t('have_code')}</h3>
          <div className="mt-1 flex gap-2">
            <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={20} aria-label={t('have_code')}
              className="min-w-0 flex-1 rounded-lg px-3 py-2 font-mono text-sm ring-1 ring-ink-200" />
            <button className={btn} disabled={busy || code.trim().length < 6}
              onClick={async () => { if (await call(() => supabaseBrowser().rpc('portal_apply_referral', { p_token: token, p_code: code.trim() }), t('code_applied'))) setCode(''); }}>
              {t('apply')}
            </button>
          </div>
        </div>
      )}
      {note}
    </section>
  );
}

export function HealthCardPortal({ token, tags, options, t }: { token: string; tags: string[]; options: string[]; t: T }) {
  const { busy, call, note } = useCall();
  const [sel, setSel] = useState<string[]>(tags);
  const [consent, setConsent] = useState(false);
  const changed = sel.slice().sort().join() !== tags.slice().sort().join();
  return (
    <section className={card} data-testid="portal-health">
      <h2 className="mb-1 text-sm font-semibold">{t('health')}</h2>
      <p className="text-xs text-ink-500">{t('health_note')}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {options.map((o) => {
          const on = sel.includes(o);
          return (
            <button key={o} type="button" aria-pressed={on} onClick={() => setSel(on ? sel.filter((x) => x !== o) : [...sel, o])}
              className={`rounded-full px-3 py-1.5 text-sm ring-1 ${on ? 'bg-ink-800 text-white ring-ink-800' : 'bg-white text-ink-700 ring-ink-200'}`}>
              {healthLabel(o)}
            </button>
          );
        })}
      </div>
      {sel.length > 0 && changed && (
        <label className="mt-2 flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>{t('health_consent')}</span>
        </label>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {changed && sel.length > 0 && (
          <button className={btn} disabled={busy || !consent}
            onClick={async () => { if (await call(() => supabaseBrowser().rpc('portal_set_health_tags', { p_token: token, p_tags: sel, p_consent: true }), t('done'))) setConsent(false); }}>
            {t('health_save')}
          </button>
        )}
        {tags.length > 0 && (
          <button className={`${btn} text-red-700`} disabled={busy}
            onClick={async () => { if (await call(() => supabaseBrowser().rpc('portal_set_health_tags', { p_token: token, p_tags: [] }), t('done'))) setSel([]); }}>
            {t('health_remove')}
          </button>
        )}
      </div>
      {note}
    </section>
  );
}

/** Only rendered when portal_get().kitchen_switching is true (platform flag on, platform customer). */
export function SwitchKitchenCard({ token, t }: { token: string; t: T }) {
  const { busy, call, note } = useCall();
  const [opts, setOpts] = useState<SwitchOptions | null>(null);
  const [reason, setReason] = useState('');
  const load = async () => setOpts(await call(() => supabaseBrowser().rpc('portal_switch_options', { p_token: token })) as SwitchOptions | null);
  return (
    <section className={card} data-testid="switch-kitchen">
      <h2 className="mb-1 text-sm font-semibold">{t('switch_title')}</h2>
      <p className="text-xs text-ink-500">{t('switch_note')}</p>
      {!opts ? (
        <button className={`${btn} mt-2`} disabled={busy} onClick={load}>{t('switch_show')}</button>
      ) : opts.open_request ? (
        <div className="mt-2 text-sm">
          <p>{t('switch_pending', { kitchen: opts.open_request.kitchen_name })}</p>
          <button className={`${btn} mt-2`} disabled={busy} onClick={async () => { await call(() => supabaseBrowser().rpc('portal_cancel_switch', { p_token: token })); await load(); }}>{t('switch_cancel')}</button>
        </div>
      ) : opts.options.length === 0 ? (
        <p className="mt-2 text-sm text-ink-600">{t('switch_none')}</p>
      ) : (
        <>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={300} placeholder={t('switch_reason')}
            className="mt-2 w-full rounded-lg px-3 py-2 text-sm ring-1 ring-ink-200" />
          <ul className="mt-2 space-y-2 text-sm">
            {opts.options.map((o) => (
              <li key={o.kitchen_id} className="flex items-center justify-between gap-2">
                <span className="min-w-0">
                  <a href={o.profile_url} target="_blank" rel="noreferrer" className="font-medium underline">{o.name}</a>
                  <span className="block text-xs text-ink-500">{[o.area, t('km', { n: o.distance_km }), o.rating ? `★ ${o.rating}` : null].filter(Boolean).join(' · ')} · {formatPaise(o.price_per_meal_paise)}</span>
                </span>
                <button className={btn} disabled={busy}
                  onClick={async () => { await call(() => supabaseBrowser().rpc('portal_request_switch', { p_token: token, p_kitchen: o.kitchen_id, ...(reason.trim() ? { p_reason: reason.trim() } : {}) }), t('done')); await load(); }}>
                  {t('switch_request')}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {note}
    </section>
  );
}
