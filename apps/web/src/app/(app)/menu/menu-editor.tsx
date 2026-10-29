'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { SLOT_LABEL, formatServiceDate, isoDow } from '@tiffin/core';
import type { MealSlot } from '@tiffin/db';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { Alert, Button, Card, Textarea } from '@/components/ui';

type Menu = { id: string; service_date: string; slot: MealSlot; dishes: string[]; notes: string | null };
const SLOTS: MealSlot[] = ['lunch', 'dinner'];

export function MenuEditor({ kitchenId, days, weeklyOff, menus }: { kitchenId: string; days: string[]; weeklyOff: number[]; menus: Menu[] }) {
  const router = useRouter();
  const key = (d: string, s: MealSlot) => `${d}:${s}`;
  const existing = new Map(menus.map((m) => [key(m.service_date, m.slot), m]));
  const [text, setText] = useState<Record<string, string>>(
    Object.fromEntries(menus.map((m) => [key(m.service_date, m.slot), m.dishes.join('\n')])),
  );
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function save(date: string, slot: MealSlot) {
    setError('');
    const k = key(date, slot);
    const dishes = (text[k] ?? '').split(/[\n,]/).map((d) => d.trim()).filter(Boolean);
    const supabase = supabaseBrowser();
    const current = existing.get(k);
    const { error } = current
      ? await supabase.from('menus').update({ dishes, published: true }).eq('id', current.id)
      : await supabase.from('menus').insert({ kitchen_id: kitchenId, service_date: date, slot, dishes, published: true });
    if (error) return setError(friendlyError(error));
    setSaved(k);
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <Alert>{error}</Alert>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {days.map((d) => {
          const off = weeklyOff.includes(isoDow(d));
          return (
            <Card key={d} title={formatServiceDate(d)} actions={off && <span className="text-xs text-ink-500">Weekly off</span>}>
              <div className="space-y-3">
                {SLOTS.map((s) => {
                  const k = key(d, s);
                  return (
                    <div key={s}>
                      <div className="mb-1 text-xs font-medium uppercase text-ink-500">{SLOT_LABEL[s]}</div>
                      <Textarea rows={3} placeholder="One dish per line" value={text[k] ?? ''} onChange={(e) => setText({ ...text, [k]: e.target.value })} disabled={off} />
                      {!off && (
                        <div className="mt-1 flex items-center gap-2">
                          <Button variant="secondary" className="px-3 py-1" onClick={() => save(d, s)}>Save</Button>
                          {saved === k && <span className="text-xs text-green-700">Saved</span>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
