'use client';

import { selectKitchen } from '@/app/actions';
import type { Membership } from '@/lib/session';
import { ROLE_LABEL } from './ui';

export function KitchenSwitcher({ memberships, current }: { memberships: Membership[]; current: Membership }) {
  if (memberships.length <= 1) {
    return (
      <div>
        <div className="truncate text-sm font-semibold text-ink-900">{current.kitchenName}</div>
        <div className="text-xs text-ink-500">{ROLE_LABEL[current.role]}</div>
      </div>
    );
  }
  return (
    <select
      aria-label="Kitchen"
      className="w-full rounded-lg border-0 bg-ink-50 px-2 py-1.5 text-sm font-semibold ring-1 ring-ink-200"
      value={current.kitchenId}
      onChange={(e) => selectKitchen(e.target.value)}
    >
      {memberships.map((m) => (
        <option key={m.kitchenId} value={m.kitchenId}>
          {m.kitchenName} ({ROLE_LABEL[m.role]})
        </option>
      ))}
    </select>
  );
}
