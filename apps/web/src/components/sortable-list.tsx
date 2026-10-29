'use client';

import { useState, type ReactNode } from 'react';

export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items;
  const next = items.slice();
  const [it] = next.splice(from, 1);
  next.splice(to, 0, it!);
  return next;
}

/**
 * Ordered list that reorders by drag and drop (HTML5 drag events, desktop) or the ▲ ▼ buttons
 * (touch and keyboard). Calls onReorder with the whole new order; the caller saves it.
 */
export function SortableList<T extends { id: string }>({
  items,
  onReorder,
  renderItem,
  disabled = false,
  label = 'item',
}: {
  items: T[];
  onReorder: (next: T[]) => void;
  renderItem: (item: T, index: number) => ReactNode;
  disabled?: boolean;
  label?: string;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  function end() {
    setDragId(null);
    setOverId(null);
  }

  return (
    <ol className="divide-y divide-ink-100">
      {items.map((item, i) => (
        <li
          key={item.id}
          draggable={!disabled}
          onDragStart={(e) => {
            setDragId(item.id);
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', item.id);
          }}
          onDragOver={(e) => {
            if (!dragId) return; // a drag from another list
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (overId !== item.id) setOverId(item.id);
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (dragId && dragId !== item.id) {
              onReorder(moveItem(items, items.findIndex((x) => x.id === dragId), i));
            }
            end();
          }}
          onDragEnd={end}
          data-testid="sortable-item"
          className={`flex items-start gap-2 py-2 ${dragId === item.id ? 'opacity-50' : ''} ${
            overId === item.id && dragId !== item.id ? 'bg-brand-50 ring-2 ring-brand-300' : ''
          } ${disabled ? '' : 'cursor-grab'}`}
        >
          {!disabled && (
            <div className="flex shrink-0 flex-col text-xs leading-none text-ink-500">
              <button
                type="button"
                aria-label={`Move ${label} up`}
                disabled={i === 0}
                onClick={() => onReorder(moveItem(items, i, i - 1))}
                className="rounded px-1 py-0.5 hover:bg-ink-100 disabled:opacity-30"
              >
                ▲
              </button>
              <button
                type="button"
                aria-label={`Move ${label} down`}
                disabled={i === items.length - 1}
                onClick={() => onReorder(moveItem(items, i, i + 1))}
                className="rounded px-1 py-0.5 hover:bg-ink-100 disabled:opacity-30"
              >
                ▼
              </button>
            </div>
          )}
          <div className="min-w-0 flex-1">{renderItem(item, i)}</div>
        </li>
      ))}
    </ol>
  );
}
