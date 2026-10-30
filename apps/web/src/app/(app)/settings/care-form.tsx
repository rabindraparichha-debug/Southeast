'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { WEEKDAYS } from '@tiffin/core';
import type { Tables } from '@tiffin/db';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Alert, Button, Card, Field, Input } from '@/components/ui';

const Toggle = ({ checked, onChange, label, hint, testId }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; testId?: string }) => (
  <label className="flex items-start gap-2 text-sm">
    <input type="checkbox" className="mt-1" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
    <span>
      <span className="font-medium text-ink-800">{label}</span>
      {hint && <span className="block text-xs text-ink-500">{hint}</span>}
    </span>
  </label>
);

// P5 kitchen settings: Odisha food calendar, customer care (first-complaint credit, referrals) and alerts.
export function CareForm({ settings }: { settings: Tables<'kitchen_settings'> }) {
  const router = useRouter();
  const [s, setS] = useState({
    veg_days: settings.veg_days ?? [2, 4],
    veg_days_enabled: settings.veg_days_enabled,
    kartika_veg_mode: settings.kartika_veg_mode,
    auto_credit_first_complaint: settings.auto_credit_first_complaint,
    referral_reward_meals: String(settings.referral_reward_meals ?? 0),
    late_alert_minutes: String(settings.late_alert_minutes ?? 90),
    weather_alerts: settings.weather_alerts,
    weather_customer_notice: settings.weather_customer_notice,
  });
  const [msg, setMsg] = useState<{ tone: 'red' | 'green'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    const reward = Number(s.referral_reward_meals);
    const late = Number(s.late_alert_minutes);
    if (!Number.isInteger(reward) || reward < 0 || reward > 10) return setMsg({ tone: 'red', text: 'Referral reward must be 0 to 10 meals.' });
    if (!Number.isInteger(late) || late < 30 || late > 600) return setMsg({ tone: 'red', text: 'Late-delivery alert must be 30 to 600 minutes.' });
    if (s.veg_days_enabled && s.veg_days.length === 0) return setMsg({ tone: 'red', text: 'Choose at least one veg day, or turn veg days off.' });
    setBusy(true);
    const { error } = await supabaseBrowser().from('kitchen_settings').update({
      veg_days: [...s.veg_days].sort(), veg_days_enabled: s.veg_days_enabled, kartika_veg_mode: s.kartika_veg_mode,
      auto_credit_first_complaint: s.auto_credit_first_complaint, referral_reward_meals: reward, late_alert_minutes: late,
      weather_alerts: s.weather_alerts, weather_customer_notice: s.weather_customer_notice,
    }).eq('kitchen_id', settings.kitchen_id);
    setBusy(false);
    if (error) return setMsg({ tone: 'red', text: friendlyError(error) });
    setMsg({ tone: 'green', text: 'Saved.' });
    router.refresh();
  }

  return (
    <form onSubmit={save} className="mt-6 grid gap-6 lg:grid-cols-2" data-testid="care-form">
      <Card title="Odisha food calendar">
        <div className="space-y-4">
          <Toggle checked={s.veg_days_enabled} onChange={(v) => setS({ ...s, veg_days_enabled: v })} testId="veg-days-enabled"
            label="Veg days" hint="Customers who observe veg days get veg instead of non-veg on these days and on veg-only festivals. You choose who observes on their page." />
          <div className="flex flex-wrap gap-2" aria-label="Veg days of the week">
            {WEEKDAYS.map((d) => {
              const on = s.veg_days.includes(d.iso);
              return (
                <button type="button" key={d.iso} aria-pressed={on} disabled={!s.veg_days_enabled}
                  onClick={() => setS({ ...s, veg_days: on ? s.veg_days.filter((x) => x !== d.iso) : [...s.veg_days, d.iso] })}
                  className={`rounded-lg px-3 py-1.5 text-sm ring-1 disabled:opacity-50 ${on ? 'bg-green-700 text-white ring-green-700' : 'bg-white text-ink-700 ring-ink-200'}`}>
                  {d.short}
                </button>
              );
            })}
          </div>
          <Toggle checked={s.kartika_veg_mode} onChange={(v) => setS({ ...s, kartika_veg_mode: v })} testId="kartika-mode"
            label="Kartika month veg mode" hint="During Kartika (dates from the platform calendar), customers who observe it get veg for the whole month." />
          <p className="text-xs text-ink-500">Changes re-plan the next 7 days at once. Meals already locked are never changed.</p>
        </div>
      </Card>

      <Card title="Customer care">
        <div className="space-y-4">
          <Toggle checked={s.auto_credit_first_complaint} onChange={(v) => setS({ ...s, auto_credit_first_complaint: v })} testId="auto-credit"
            label="Credit 1 free meal for a customer’s first complaint"
            hint="Only the first food or delivery complaint per customer, once. The meal comes out of your kitchen’s pocket, but it calms an unhappy customer quickly. On by default." />
          <Field label="Referral reward (meals for both)" hint="When a new customer joins with a friend’s code and makes their first payment, both get this many free meals, paid by your kitchen. 0 = off.">
            <Input type="number" min={0} max={10} inputMode="numeric" value={s.referral_reward_meals} onChange={(e) => setS({ ...s, referral_reward_meals: e.target.value })} data-testid="referral-meals" />
          </Field>
        </div>
      </Card>

      <Card title="Alerts">
        <div className="space-y-4">
          <Field label="Late-delivery alert after (minutes)" hint="From the packed-meals photo (or the run start). You get a WhatsApp if stops are still undelivered by then.">
            <Input type="number" min={30} max={600} step={5} inputMode="numeric" value={s.late_alert_minutes} onChange={(e) => setS({ ...s, late_alert_minutes: e.target.value })} data-testid="late-minutes" />
          </Field>
          <Toggle checked={s.weather_alerts} onChange={(v) => setS({ ...s, weather_alerts: v })} testId="weather-alerts"
            label="Rain and heat alerts" hint="A WhatsApp to you when heavy rain or strong heat is forecast at meal time, so you can send riders early." />
          <Toggle checked={s.weather_customer_notice} onChange={(v) => setS({ ...s, weather_customer_notice: v })} testId="weather-notice"
            label="Tell customers about weather delays" hint="Customers with a meal in that slot get a short ‘may be a little late’ message." />
        </div>
      </Card>

      <div className="flex items-center gap-3 lg:col-span-2">
        <Button type="submit" disabled={busy} data-testid="save-care">{busy ? 'Saving…' : 'Save these settings'}</Button>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      </div>
    </form>
  );
}
