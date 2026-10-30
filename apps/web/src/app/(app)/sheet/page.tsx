import Link from 'next/link';
import { SLOT_LABEL, addDays, formatIstShort, formatServiceDate, istDate, isIsoDate } from '@tiffin/core';
import type { MealSlot, SlotSummary } from '@tiffin/db';
import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { Badge, Card, DIET_LABEL, PageHeader } from '@/components/ui';
import { PrintButton } from '@/components/print-button';
import { healthLabel, type SlotTotalsP5 } from '@/lib/p5';

function neighbours(date: string, slot: MealSlot) {
  const prev = slot === 'dinner' ? { date, slot: 'lunch' as const } : { date: addDays(date, -1), slot: 'dinner' as const };
  const next = slot === 'lunch' ? { date, slot: 'dinner' as const } : { date: addDays(date, 1), slot: 'lunch' as const };
  return { prev, next };
}

// Production sheet + packing list for one slot. Printable (sidebar hidden in print).
export default async function SheetPage({ searchParams }: PageProps<'/sheet'>) {
  const { kitchen } = await requireKitchen(['owner', 'staff']);
  const sp = await searchParams;
  const date = isIsoDate(sp.date) ? sp.date : addDays(istDate(), 1);
  const slot: MealSlot = sp.slot === 'dinner' ? 'dinner' : 'lunch';
  const supabase = await createClient();

  const [{ data: summaryRaw }, { data: packing }, { data: menu }, { data: k }] = await Promise.all([
    supabase.rpc('slot_summary', { p_kitchen: kitchen.kitchenId, p_date: date, p_slot: slot }),
    supabase.rpc('packing_list', { p_kitchen: kitchen.kitchenId, p_date: date, p_slot: slot }),
    supabase.from('menus').select('dishes, notes').eq('kitchen_id', kitchen.kitchenId).eq('service_date', date).eq('slot', slot).maybeSingle(),
    supabase.from('kitchens').select('name').eq('id', kitchen.kitchenId).single(),
  ]);
  const s = summaryRaw as unknown as SlotSummary;
  const totals: SlotTotalsP5 = s.locked && s.locked_totals ? s.locked_totals : s.live;
  const byHealth = Object.entries(totals.by_health ?? {}).sort((a, b) => b[1] - a[1]);
  const rows = packing ?? [];
  const notes = rows.filter((r) => r.customer_notes || r.delivery_notes);
  const { prev, next } = neighbours(date, slot);

  return (
    <>
      <PageHeader
        title={`${formatServiceDate(date)} · ${SLOT_LABEL[slot]}`}
        subtitle={
          <span>
            {k?.name} ·{' '}
            {s.locked ? `Final count, locked ${formatIstShort(s.locked_at!)}` : `Preview — changes allowed until ${formatIstShort(s.cutoff_at)}`}
          </span>
        }
        actions={
          <div className="flex gap-2 print:hidden">
            <Link href={`/sheet?date=${prev.date}&slot=${prev.slot}`} className="rounded-lg px-3 py-2 text-sm ring-1 ring-ink-200 hover:bg-ink-50">← {SLOT_LABEL[prev.slot]}</Link>
            <Link href={`/sheet?date=${next.date}&slot=${next.slot}`} className="rounded-lg px-3 py-2 text-sm ring-1 ring-ink-200 hover:bg-ink-50">{SLOT_LABEL[next.slot]} →</Link>
            <Link href={`/print/stickers?date=${date}&slot=${slot}`} className="rounded-lg px-3 py-2 text-sm ring-1 ring-ink-200 hover:bg-ink-50">🏷️ Stickers</Link>
            <PrintButton />
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3 print:grid-cols-3 print:gap-3">
        <Card title="Production">
          <div className="text-4xl font-semibold">{totals.total_meals}</div>
          <div className="text-sm text-ink-500">meals to cook ({totals.to_deliver} to deliver{totals.late_skips ? `, ${totals.late_skips} late skip` : ''})</div>
          <ul className="mt-4 space-y-1 text-sm">
            <li className="flex justify-between"><span>Veg</span><strong>{totals.by_diet.veg}</strong></li>
            <li className="flex justify-between"><span>Non-veg</span><strong>{totals.by_diet.nonveg}</strong></li>
            <li className="flex justify-between"><span>Jain</span><strong>{totals.by_diet.jain}</strong></li>
          </ul>
          {(totals.veg_switched ?? 0) > 0 && (
            <p className="mt-2 text-sm text-green-800" data-testid="veg-switched">Veg day: {totals.veg_switched} non-veg meal{totals.veg_switched === 1 ? '' : 's'} switched to veg (included above)</p>
          )}
          {byHealth.length > 0 && (
            <>
              <h3 className="mt-4 text-sm font-semibold">Health needs</h3>
              <ul className="mt-1 space-y-1 text-sm" data-testid="by-health">
                {byHealth.map(([tag, n]) => <li key={tag} className="flex justify-between"><span>{healthLabel(tag)}</span><strong>{n}</strong></li>)}
              </ul>
            </>
          )}
          <p className="mt-4 text-xs print:hidden"><Link href={`/inventory/recipes?date=${date}&slot=${slot}#plan`} className="text-brand-700 hover:underline">Ingredients for this meal →</Link></p>
        </Card>
        <Card title="By plan">
          <ul className="space-y-1 text-sm">
            {totals.by_plan.map((p) => <li key={p.plan} className="flex justify-between"><span>{p.plan}</span><strong>{p.meals}</strong></li>)}
            {totals.by_plan.length === 0 && <li className="text-ink-500">No meals.</li>}
          </ul>
          <h3 className="mt-4 text-sm font-semibold">By area</h3>
          <ul className="mt-1 space-y-1 text-sm">
            {totals.by_area.map((a) => <li key={a.area} className="flex justify-between"><span>{a.area}</span><strong>{a.meals}</strong></li>)}
          </ul>
        </Card>
        <Card title="Menu">
          {menu?.dishes?.length ? (
            <ul className="list-inside list-disc text-sm">{menu.dishes.map((d) => <li key={d}>{d}</li>)}</ul>
          ) : (
            <p className="text-sm text-ink-500">No menu set. <Link href="/menu" className="text-brand-700 hover:underline print:hidden">Set menu</Link></p>
          )}
          {menu?.notes && <p className="mt-2 text-sm text-ink-600">{menu.notes}</p>}
        </Card>
      </div>

      {notes.length > 0 && (
        <Card title="Special notes" className="mt-6 print:mt-3">
          <ul className="space-y-1 text-sm">
            {notes.map((r) => (
              <li key={r.order_id}><strong>{r.customer_name}</strong>: {[r.customer_notes, r.delivery_notes].filter(Boolean).join(' · ')}</li>
            ))}
          </ul>
        </Card>
      )}

      <Card title={`Packing list (${rows.length})`} className="mt-6 overflow-x-auto print:mt-3 print:break-before-page">
        <table className="min-w-full text-sm">
          <thead className="border-b border-ink-100 text-left text-xs uppercase text-ink-500">
            <tr>
              <th className="py-2 pr-3">#</th>
              <th className="py-2 pr-3">Customer</th>
              <th className="py-2 pr-3">Address</th>
              <th className="py-2 pr-3">Tiffins</th>
              <th className="py-2 pr-3">Diet</th>
              <th className="py-2 pr-3">Plan</th>
              <th className="py-2">Notes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.map((r, i) => {
              const dontDeliver = r.status === 'skipped';
              return (
                <tr key={r.order_id} className={dontDeliver ? 'bg-amber-50 text-ink-500' : ''}>
                  <td className="py-2 pr-3">{i + 1}</td>
                  <td className="py-2 pr-3 font-medium">
                    {r.customer_name} {dontDeliver && <Badge tone="amber">Skipped late — don’t deliver</Badge>}
                    {r.health_tags && r.health_tags.length > 0 && (
                      <span className="mt-0.5 flex flex-wrap gap-1">{r.health_tags.map((t) => <Badge key={t} tone="amber">{healthLabel(t)}</Badge>)}</span>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    {r.office_name && <span className="block font-medium">🏢 {r.office_name}</span>}
                    {[r.line1, r.landmark, r.area].filter(Boolean).join(', ')}
                  </td>
                  <td className="py-2 pr-3">{r.qty}</td>
                  <td className="py-2 pr-3">{DIET_LABEL[r.diet]}{r.veg_override && <span className="block text-xs text-green-800">veg day</span>}</td>
                  <td className="py-2 pr-3">{r.plan_name}</td>
                  <td className="py-2">{[r.delivery_notes, r.customer_notes].filter(Boolean).join(' · ')}</td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={7} className="py-6 text-center text-ink-500">No meals for this slot.</td></tr>}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-ink-500">Sorted by route and stop order once runs are built, else by area and landmark.</p>
      </Card>
    </>
  );
}
