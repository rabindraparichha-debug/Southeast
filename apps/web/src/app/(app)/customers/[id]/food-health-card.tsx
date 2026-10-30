'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { WEEKDAYS } from '@tiffin/core';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError, friendlyErrorIn } from '@/lib/errors';
import { HEALTH_TAGS, healthLabel } from '@/lib/p5';
import { Alert, Badge, Button, Card } from '@/components/ui';

// Odisha food calendar opt-ins (P5) and health tags (P6). Owner edits; staff see them (they pack).
export function FoodHealthCard({ customerId, editable, vegDays, kartika, kitchen, health }: {
  customerId: string;
  editable: boolean;
  vegDays: boolean;
  kartika: boolean;
  kitchen: { vegDaysEnabled: boolean; vegDays: number[]; kartikaMode: boolean };
  health: { tags: string[]; consentAt: string | null; basis: string | null };
}) {
  const router = useRouter();
  const [prefs, setPrefs] = useState({ vegDays, kartika });
  const [tags, setTags] = useState<string[]>(health.tags);
  const [consent, setConsent] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'red' | 'green'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const dayNames = kitchen.vegDays.map((d) => WEEKDAYS[d - 1]?.short).filter(Boolean).join(', ');
  const tagsChanged = tags.slice().sort().join() !== health.tags.slice().sort().join();

  async function savePrefs() {
    setBusy(true);
    setMsg(null);
    const { error } = await supabaseBrowser().rpc('set_customer_food_prefs', { p_customer: customerId, p_veg_days: prefs.vegDays, p_kartika: prefs.kartika });
    setBusy(false);
    if (error) return setMsg({ tone: 'red', text: friendlyError(error) });
    setMsg({ tone: 'green', text: 'Food preferences saved. Open days are re-planned.' });
    router.refresh();
  }

  async function saveTags() {
    setBusy(true);
    setMsg(null);
    const { error } = await supabaseBrowser().rpc('set_health_tags', { p_customer: customerId, p_tags: tags, p_consent: consent });
    setBusy(false);
    if (error) return setMsg({ tone: 'red', text: friendlyErrorIn('health', error) });
    setConsent(false);
    setMsg({ tone: 'green', text: tags.length ? 'Health tags saved.' : 'Health tags removed and consent withdrawn.' });
    router.refresh();
  }

  return (
    <Card title="Food and health">
      <div className="space-y-4 text-sm">
        <fieldset className="space-y-2">
          <legend className="font-medium text-ink-800">Odisha food calendar</legend>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={prefs.vegDays} disabled={!editable} onChange={(e) => setPrefs({ ...prefs, vegDays: e.target.checked })} data-testid="pref-veg-days" />
            <span>
              Observes veg days{kitchen.vegDaysEnabled && dayNames ? ` (${dayNames} and veg festivals)` : ''}
              {!kitchen.vegDaysEnabled && <span className="block text-xs text-ink-500">Veg days are off for your kitchen. Turn them on in Kitchen settings.</span>}
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={prefs.kartika} disabled={!editable} onChange={(e) => setPrefs({ ...prefs, kartika: e.target.checked })} data-testid="pref-kartika" />
            <span>
              Observes Kartika month (veg for the whole month)
              {!kitchen.kartikaMode && <span className="block text-xs text-ink-500">Kartika veg mode is off for your kitchen.</span>}
            </span>
          </label>
          <p className="text-xs text-ink-500">Non-veg meals are packed veg on those days. Veg and Jain plans don’t change.</p>
          {editable && (
            <Button variant="secondary" onClick={savePrefs} disabled={busy || (prefs.vegDays === vegDays && prefs.kartika === kartika)} data-testid="save-prefs">
              Save food preferences
            </Button>
          )}
        </fieldset>

        <fieldset className="space-y-2 border-t border-ink-100 pt-4">
          <legend className="font-medium text-ink-800">Health tags</legend>
          <p className="text-xs text-ink-500">Sensitive. Only with the customer’s consent. Shown to you and your kitchen staff on the packing list and stickers, never to riders.</p>
          {editable ? (
            <>
              <div className="flex flex-wrap gap-2">
                {HEALTH_TAGS.map((t) => {
                  const on = tags.includes(t);
                  return (
                    <button key={t} type="button" aria-pressed={on} onClick={() => setTags(on ? tags.filter((x) => x !== t) : [...tags, t])}
                      className={`rounded-full px-3 py-1.5 text-sm ring-1 ${on ? 'bg-ink-800 text-white ring-ink-800' : 'bg-white text-ink-700 ring-ink-200'}`}>
                      {healthLabel(t)}
                    </button>
                  );
                })}
              </div>
              {tags.length > 0 && (
                <label className="flex items-start gap-2">
                  <input type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} data-testid="health-consent" />
                  <span>The customer agreed that my kitchen may record this health information to prepare their food.</span>
                </label>
              )}
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={saveTags} disabled={busy || !tagsChanged || (tags.length > 0 && !consent)} data-testid="save-health">
                  {tags.length === 0 && health.tags.length > 0 ? 'Remove health tags' : 'Save health tags'}
                </Button>
              </div>
            </>
          ) : health.tags.length ? (
            <div className="flex flex-wrap gap-1.5">{health.tags.map((t) => <Badge key={t} tone="amber">{healthLabel(t)}</Badge>)}</div>
          ) : (
            <p className="text-ink-500">None recorded.</p>
          )}
          {health.consentAt && (
            <p className="text-xs text-ink-500">
              Consent {health.basis === 'customer' ? 'given by the customer on their page' : 'recorded by the kitchen'} on{' '}
              {new Date(health.consentAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' })}.
            </p>
          )}
        </fieldset>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      </div>
    </Card>
  );
}
