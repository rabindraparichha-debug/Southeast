'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { formatIstShort } from '@tiffin/core';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import { formatDay, formatQty, formatSignedQty, type InventoryAlert } from '@/lib/inventory';
import { ErrorText, FieldInput, Muted, Panel } from '@/components/field-ui';
import { LowBadge, toStockItems, type StockItem } from './stock-ui';
import { PurchaseView } from './purchase';
import { WasteView } from './waste';
import { CountView } from './count';

// Stock at a glance plus quick entry (web port of apps/mobile/src/app/(tabs)/stock.tsx and stock/*).
// The sub-screens live in the URL hash (#purchase, #waste, #waste=<item>, #count) so the page needs
// no server round trip to switch, and the browser back button works.

type View = { name: 'home' } | { name: 'purchase' } | { name: 'waste'; item?: string } | { name: 'count' };

const subscribeHash = (cb: () => void) => {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
};
const readHash = () => (typeof location === 'undefined' ? '' : location.hash);

function parseView(hash: string): View {
  if (hash === '#purchase') return { name: 'purchase' };
  if (hash === '#count') return { name: 'count' };
  const w = /^#waste(?:=([\w-]+))?$/.exec(hash);
  if (w) return { name: 'waste', item: w[1] };
  return { name: 'home' };
}

// True when the current sub-screen was opened from the list (so Back can use the browser history).
let openedHere = false;

type Cached = { items: StockItem[]; alerts: InventoryAlert[]; at: string };
const cacheKey = (kitchenId: string) => `tiffin.stock.${kitchenId}`;

function readCache(kitchenId: string): Cached | null {
  try {
    const raw = localStorage.getItem(cacheKey(kitchenId));
    return raw ? (JSON.parse(raw) as Cached) : null;
  } catch {
    return null;
  }
}

function alertText(a: InventoryAlert): string {
  if (a.type === 'low_stock') return `${a.item}: ${formatQty(a.stock, a.unit)} left (min ${formatQty(a.min_qty, a.unit)})`;
  if (a.type === 'price_jump') {
    const pct = Math.abs(Math.round(Number(a.pct)));
    return `${a.item}: price ${Number(a.pct) >= 0 ? 'up' : 'down'} ${pct}% on the ${formatDay(a.bill_date)} bill`;
  }
  return `${a.item}: ${formatSignedQty(a.variance, a.unit)} in the stock-take on ${formatDay(a.date)}`;
}

export function StockEntry({ kitchenId, isOwner }: { kitchenId: string; isOwner: boolean }) {
  const hash = useSyncExternalStore(subscribeHash, readHash, () => '');
  const view = parseView(hash);
  const [items, setItems] = useState<StockItem[]>([]);
  const [alerts, setAlerts] = useState<InventoryAlert[]>([]);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const s = supabaseBrowser();
    const [levels, al] = await Promise.all([s.rpc('stock_levels', { p_kitchen: kitchenId }), s.rpc('inventory_alerts', { p_kitchen: kitchenId })]);
    setLoading(false);
    const e = levels.error ?? al.error;
    if (e) {
      // Offline: keep showing the last list we had.
      const cached = readCache(kitchenId);
      if (cached) {
        setItems(cached.items);
        setAlerts(cached.alerts);
        setCachedAt(cached.at);
      }
      return setError(friendlyError(e));
    }
    const next: Cached = { items: toStockItems(levels.data), alerts: (al.data as unknown as InventoryAlert[] | null) ?? [], at: new Date().toISOString() };
    setError('');
    setItems(next.items);
    setAlerts(next.alerts);
    setCachedAt(null);
    try {
      localStorage.setItem(cacheKey(kitchenId), JSON.stringify(next));
    } catch {
      // storage full or blocked
    }
  }, [kitchenId]);

  // Reload whenever we come back to the list (after a purchase, waste or count).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading data from Supabase on view change
    if (view.name === 'home') void load();
  }, [view.name, load]);

  const go = (h: string) => {
    openedHere = true;
    location.hash = h;
  };
  const back = () => {
    if (openedHere) {
      openedHere = false;
      history.back();
    } else {
      history.replaceState(history.state, '', location.pathname + location.search);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    }
  };

  if (view.name === 'purchase') return <PurchaseView kitchenId={kitchenId} isOwner={isOwner} onDone={back} />;
  if (view.name === 'waste') return <WasteView kitchenId={kitchenId} initialItem={view.item} onDone={back} />;
  if (view.name === 'count') return <CountView kitchenId={kitchenId} onDone={back} />;

  return <Home items={items} alerts={alerts} loading={loading} error={error} cachedAt={cachedAt} onGo={go} onReload={load} />;
}

function Home({ items, alerts, loading, error, cachedAt, onGo, onReload }: {
  items: StockItem[]; alerts: InventoryAlert[]; loading: boolean; error: string; cachedAt: string | null;
  onGo: (hash: string) => void; onReload: () => void;
}) {
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? items.filter((r) => r.name.toLowerCase().includes(s)) : items;
  }, [items, q]);

  return (
    <div className="space-y-3 pb-8">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink-900">Stock entry</h1>
        <button type="button" onClick={onReload} disabled={loading} className="text-sm font-medium text-brand-700 disabled:text-ink-400">
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Action label="Purchase" emoji="🧾" onClick={() => onGo('purchase')} testId="action-purchase" />
        <Action label="Waste" emoji="🗑️" onClick={() => onGo('waste')} testId="action-waste" />
        <Action label="Stock-take" emoji="⚖️" onClick={() => onGo('count')} testId="action-count" />
      </div>
      <ErrorText>{error}</ErrorText>
      {cachedAt && <Muted>Showing the list from {formatIstShort(cachedAt)}. Saving needs network.</Muted>}
      {alerts.length > 0 && (
        <Panel tone="brand">
          <h2 className="text-base font-semibold text-ink-900">Alerts</h2>
          <ul className="space-y-1">
            {alerts.map((a, i) => (
              <li key={`${a.type}-${a.item_id}-${i}`} className={`text-sm ${a.type === 'low_stock' ? 'text-red-700' : 'text-ink-700'}`} data-testid={`alert-${a.type}`}>
                • {alertText(a)}
              </li>
            ))}
          </ul>
        </Panel>
      )}
      <FieldInput type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search items" data-testid="stock-search" />
      <ul className="divide-y divide-ink-100 overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-ink-100">
        {shown.map((item) => (
          <li key={item.item_id} className="flex items-center gap-3 px-4 py-3" data-testid={`stock-row-${item.name}`}>
            <div className="min-w-0 flex-1">
              <p className="truncate text-base font-semibold text-ink-900">{item.name}</p>
              {item.min_qty > 0 && <p className="text-xs text-ink-500">min {formatQty(item.min_qty, item.unit)}</p>}
            </div>
            {item.low && <LowBadge />}
            <span className={`shrink-0 text-right text-base font-semibold ${item.low ? 'text-red-700' : 'text-ink-900'}`}>{formatQty(item.stock, item.unit)}</span>
            <button type="button" onClick={() => onGo(`waste=${item.item_id}`)} className="shrink-0 rounded-lg px-2 py-1 text-xs text-ink-500 ring-1 ring-ink-200" aria-label={`Record waste of ${item.name}`}>
              Waste
            </button>
          </li>
        ))}
        {!loading && shown.length === 0 && (
          <li className="p-6 text-center text-sm text-ink-500">{q ? 'No items match.' : 'No items yet. Add items in Inventory on the dashboard.'}</li>
        )}
      </ul>
      <p className="text-center text-sm text-ink-500">
        Suppliers, recipes, costs and history are in <Link href="/inventory" className="font-medium text-brand-700 underline">Inventory</Link>.
      </p>
    </div>
  );
}

function Action({ label, emoji, onClick, testId }: { label: string; emoji: string; onClick: () => void; testId: string }) {
  return (
    <button type="button" onClick={onClick} data-testid={testId}
      className="flex flex-col items-center gap-0.5 rounded-xl bg-brand-600 py-3 text-white shadow-sm active:bg-brand-700">
      <span className="text-xl" aria-hidden>{emoji}</span>
      <span className="text-sm font-semibold">{label}</span>
    </button>
  );
}
