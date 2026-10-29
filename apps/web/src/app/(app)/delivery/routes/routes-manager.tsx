'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { SLOT_LABEL } from '@tiffin/core';
import type { MealSlot } from '@tiffin/db';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyErrorIn } from '@/lib/errors';
import { Alert, Badge, Button, Card, Input, Select } from '@/components/ui';

export type RouteRow = { id: string; name: string; slot: MealSlot; rider_id: string | null; active: boolean; stops: number };
export type RiderOption = { id: string; name: string };

const SLOTS: MealSlot[] = ['lunch', 'dinner'];

export function RoutesManager({ kitchenId, routes, riders, selectedId }: { kitchenId: string; routes: RouteRow[]; riders: RiderOption[]; selectedId: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'red' | 'green'; text: string } | null>(null);
  const [draft, setDraft] = useState<Record<MealSlot, { name: string; rider: string }>>({
    lunch: { name: '', rider: '' }, dinner: { name: '', rider: '' },
  });

  async function run(p: PromiseLike<{ error: { message?: string; code?: string } | null }>, ok: string) {
    setBusy(true);
    const { error } = await p;
    setBusy(false);
    setMsg(error ? { tone: 'red', text: friendlyErrorIn('route', error) } : { tone: 'green', text: ok });
    if (!error) router.refresh();
    return !error;
  }

  async function create(e: FormEvent, slot: MealSlot) {
    e.preventDefault();
    const d = draft[slot];
    const ok = await run(
      supabaseBrowser().rpc('create_route', { p_kitchen: kitchenId, p_slot: slot, p_name: d.name, p_rider: d.rider || undefined }),
      `Route “${d.name.trim()}” added. Move stops into it from the live board, or it fills with new customers nearby.`,
    );
    if (ok) setDraft({ ...draft, [slot]: { name: '', rider: '' } });
  }

  function rename(r: RouteRow) {
    const name = window.prompt('Route name', r.name)?.trim();
    if (name && name !== r.name) void run(supabaseBrowser().rpc('update_route', { p_route: r.id, p_name: name }), 'Route renamed.');
  }

  return (
    <div className="space-y-4">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {SLOTS.map((slot) => {
        const list = routes.filter((r) => r.slot === slot);
        return (
          <Card key={slot} title={`${SLOT_LABEL[slot]} routes`}>
            {list.length === 0 && <p className="mb-3 text-sm text-ink-500">No routes yet. One is created automatically when the first {SLOT_LABEL[slot].toLowerCase()} count locks.</p>}
            <ul className="divide-y divide-ink-100">
              {list.map((r) => (
                <li key={r.id} data-testid="route-row" className={`space-y-2 py-3 ${r.id === selectedId ? '-mx-2 rounded-lg bg-brand-50 px-2' : ''}`}>
                  <div className="flex items-center justify-between gap-2">
                    <Link href={`/delivery/routes?route=${r.id}`} className="font-medium text-ink-900 hover:text-brand-700">
                      {r.name}
                    </Link>
                    <span className="flex items-center gap-2 text-xs text-ink-500">
                      {r.stops} stop(s)
                      {!r.active && <Badge tone="gray">Inactive</Badge>}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Select
                      aria-label={`Default rider for ${r.name}`}
                      className="max-w-56"
                      value={r.rider_id ?? ''}
                      disabled={busy}
                      onChange={(e) =>
                        run(
                          supabaseBrowser().rpc('update_route', e.target.value
                            ? { p_route: r.id, p_rider: e.target.value }
                            : { p_route: r.id, p_clear_rider: true }),
                          'Default rider saved. Planned runs from today follow it.',
                        )
                      }
                    >
                      <option value="">No default rider</option>
                      {r.rider_id && !riders.some((x) => x.id === r.rider_id) && <option value={r.rider_id}>Former member</option>}
                      {riders.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </Select>
                    <label className="flex items-center gap-1.5 text-sm text-ink-700">
                      <input
                        type="checkbox"
                        checked={r.active}
                        disabled={busy}
                        onChange={(e) => {
                          const active = e.target.checked;
                          const lastActive = !active && list.filter((x) => x.active).length === 1;
                          if (lastActive && !window.confirm('This is the only active route for this meal. Without one, runs cannot be planned. Pause it anyway?')) return;
                          void run(supabaseBrowser().rpc('update_route', { p_route: r.id, p_active: active }),
                            active ? 'Route active.' : 'Route paused. Its customers move to other routes at the next planning.');
                        }}
                      />
                      Active
                    </label>
                    <Button variant="ghost" className="px-2 py-1" onClick={() => rename(r)} disabled={busy}>Rename</Button>
                    <Link href={`/delivery/routes?route=${r.id}`} className="ml-auto text-sm font-medium text-brand-700 hover:underline">Open →</Link>
                  </div>
                </li>
              ))}
            </ul>
            <form onSubmit={(e) => create(e, slot)} className="mt-3 flex flex-wrap items-center gap-2 border-t border-ink-100 pt-3">
              <Input
                aria-label={`New ${SLOT_LABEL[slot].toLowerCase()} route name`}
                placeholder="New route name"
                className="w-40 flex-1"
                maxLength={60}
                required
                value={draft[slot].name}
                onChange={(e) => setDraft({ ...draft, [slot]: { ...draft[slot], name: e.target.value } })}
              />
              <Select
                aria-label="Rider for the new route"
                className="w-40"
                value={draft[slot].rider}
                onChange={(e) => setDraft({ ...draft, [slot]: { ...draft[slot], rider: e.target.value } })}
              >
                <option value="">No rider</option>
                {riders.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </Select>
              <Button type="submit" variant="secondary" disabled={busy}>Add route</Button>
            </form>
          </Card>
        );
      })}
    </div>
  );
}
