import Link from 'next/link';
import { CHECKLIST, type ChecklistItem } from '@/lib/checklist';
import { Card } from './ui';

// Owner's "get ready for platform customers" card on Today, shown until every item is done.
export function OnboardingChecklist({ items }: { items: ChecklistItem[] }) {
  const done = items.filter((i) => i.done).length;
  if (!items.length || done === items.length) return null;
  return (
    <Card
      title="Get your kitchen ready"
      actions={<span className="text-sm text-ink-500">{done} of {items.length} done</span>}
      className="mb-6"
    >
      <div className="mb-4 h-2 overflow-hidden rounded-full bg-ink-100">
        <div className="h-full rounded-full bg-brand-500" style={{ width: `${Math.round((done / items.length) * 100)}%` }} />
      </div>
      <ul className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {items.map((i) => {
          const c = CHECKLIST[i.key] ?? { label: i.key, hint: '', href: '/settings' };
          return (
            <li key={i.key} className="flex items-start gap-2 text-sm">
              <span aria-hidden className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs ${i.done ? 'bg-green-600 text-white' : 'ring-1 ring-ink-200'}`}>
                {i.done ? '✓' : ''}
              </span>
              {i.done ? (
                <span className="text-ink-500 line-through">{c.label}</span>
              ) : (
                <span>
                  <Link href={c.href} className="font-medium text-brand-700 hover:underline">{c.label}</Link>
                  <span className="block text-xs text-ink-500">{c.hint}</span>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
