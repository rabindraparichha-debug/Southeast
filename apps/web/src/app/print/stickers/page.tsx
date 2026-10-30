import type { Metadata } from 'next';
import QRCode from 'qrcode';
import { SLOT_LABEL, addDays, formatServiceDate, isIsoDate } from '@tiffin/core';
import type { MealSlot } from '@tiffin/db';
import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { friendlyError } from '@/lib/errors';
import { currentDeliverySlot } from '@/lib/delivery';
import { healthLabel, type StickerStop } from '@/lib/p5';
import { PrintButton } from '@/components/print-button';

export const metadata: Metadata = { title: 'Tiffin stickers' };

const DIET_SHORT: Record<string, string> = { veg: 'Veg', nonveg: 'Non-veg', jain: 'Jain' };

// One sticker per delivery stop, in route order (P5). The QR holds the stop's sticker code; the rider
// scans it before handing over the tiffin (complete_stop refuses a wrong one). Owner + staff: the
// sheet carries no phone numbers and no money.
export default async function StickersPage({ searchParams }: PageProps<'/print/stickers'>) {
  const { kitchen } = await requireKitchen(['owner', 'staff']);
  const sp = await searchParams;
  const now = currentDeliverySlot();
  const date = isIsoDate(sp.date) ? sp.date : now.date;
  const slot: MealSlot = sp.slot === 'dinner' || sp.slot === 'lunch' ? sp.slot : now.slot;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('sticker_sheet', { p_kitchen: kitchen.kitchenId, p_date: date, p_slot: slot });
  const stops = (data ?? []) as unknown as StickerStop[];
  const qrs = await Promise.all(stops.map((s) => QRCode.toString(s.qr_token, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' })));
  const prev = slot === 'dinner' ? { date, slot: 'lunch' } : { date: addDays(date, -1), slot: 'dinner' };
  const next = slot === 'lunch' ? { date, slot: 'dinner' } : { date: addDays(date, 1), slot: 'lunch' };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3 print:hidden">
        <div>
          <h1 className="text-lg font-semibold">{kitchen.kitchenName} · Stickers</h1>
          <p className="text-sm text-ink-500">{formatServiceDate(date)} · {SLOT_LABEL[slot]} · {stops.length} stop{stops.length === 1 ? '' : 's'}. Stick one on each tiffin bag; riders scan it before handing over.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href={`/print/stickers?date=${prev.date}&slot=${prev.slot}`} className="rounded-lg px-3 py-2 text-sm ring-1 ring-ink-200">← {SLOT_LABEL[prev.slot as MealSlot]}</a>
          <a href={`/print/stickers?date=${next.date}&slot=${next.slot}`} className="rounded-lg px-3 py-2 text-sm ring-1 ring-ink-200">{SLOT_LABEL[next.slot as MealSlot]} →</a>
          <a href={`/delivery?date=${date}&slot=${slot}`} className="rounded-lg px-3 py-2 text-sm ring-1 ring-ink-200">Delivery</a>
          <PrintButton />
        </div>
      </div>
      {error && <p className="text-sm text-red-700">{friendlyError(error)}</p>}
      {!error && stops.length === 0 && (
        <p className="rounded-lg bg-ink-50 p-4 text-sm text-ink-600">No stops yet. Stops are built when the count locks at the cutoff (or when you plan runs in Delivery → Routes).</p>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 print:grid-cols-3 print:gap-2" data-testid="stickers">
        {stops.map((s, i) => {
          const diets = Object.entries(s.diets ?? {}).map(([d, n]) => `${n} ${DIET_SHORT[d] ?? d}`).join(' · ');
          return (
            <article key={s.stop_id} data-testid="sticker" className="flex break-inside-avoid gap-3 rounded-lg border border-dashed border-ink-300 p-3 text-xs print:p-2">
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="text-[11px] text-ink-500">{s.route_name} · #{s.seq}</div>
                <div className="text-sm leading-tight font-bold break-words">{s.office ? '🏢 ' : ''}{s.name}</div>
                <div className="break-words text-ink-700">{[s.line1, s.landmark, s.area].filter(Boolean).join(', ')}</div>
                <div className="font-semibold">{s.meal_count} meal{s.meal_count === 1 ? '' : 's'}{diets ? ` · ${diets}` : ''}</div>
                {s.veg_day && <div className="font-semibold text-green-800">VEG DAY: packed veg</div>}
                {s.health_tags.length > 0 && <div className="font-semibold text-amber-800">{s.health_tags.map(healthLabel).join(', ')}</div>}
                {s.office && s.eaters && s.eaters.length > 0 && (
                  <ul className="mt-1 border-t border-ink-200 pt-1">
                    {s.eaters.map((e, j) => (
                      <li key={j}>
                        {e.name}{e.qty > 1 ? ` ×${e.qty}` : ''} · {DIET_SHORT[e.diet] ?? e.diet}{e.veg_day ? ' (veg day)' : ''}
                        {e.health_tags.length > 0 && <span className="text-amber-800"> · {e.health_tags.map(healthLabel).join(', ')}</span>}
                      </li>
                    ))}
                  </ul>
                )}
                {s.notes && <div className="break-words text-ink-600 italic">{s.notes}</div>}
              </div>
              <div className="w-20 shrink-0 text-center">
                <div className="h-20 w-20 [&>svg]:h-full [&>svg]:w-full" role="img" aria-label={`QR code ${s.qr_token}`} dangerouslySetInnerHTML={{ __html: qrs[i]! }} />
                <div className="mt-1 font-mono text-[10px] tracking-wider">{s.qr_token}</div>
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
