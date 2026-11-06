import type { Metadata } from 'next';
import { requireAdmin } from '@/lib/session';
import { getFlags } from '@/lib/flags';
import { FLAG_LABELS, type Flag } from '@/lib/flag-keys';
import { Badge, Card, PageHeader } from '@/components/ui';
import { PhaseToggle } from './phase-toggle';

export const metadata: Metadata = { title: 'Phase switches · Admin' };

const ORDER: Flag[] = ['customer_whatsapp', 'customer_portal', 'online_payments', 'marketplace', 'growth', 'extras', 'kitchen_switching'];

// The platform's phase switches (D-180). Phase 1 runs with all of them off: vendors only, their
// customers stay offline. Each one opens its screens in both apps and its database entry points.
export default async function AdminFlagsPage() {
  await requireAdmin();
  const flags = await getFlags();
  return (
    <main className="mx-auto max-w-3xl p-4 md:p-8">
      <PageHeader title="Admin · Phase switches"
        subtitle="Phase 1 runs with every switch off. Turning one on opens its screens and functions for every kitchen at once." />
      <Card>
        <ul className="divide-y divide-ink-100">
          {ORDER.map((key) => (
            <li key={key} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-ink-900">{FLAG_LABELS[key].label}</span>
                  {flags[key] ? <Badge tone="green">On</Badge> : <Badge>Off</Badge>}
                </div>
                <p className="text-sm text-ink-500">{FLAG_LABELS[key].hint}</p>
              </div>
              <PhaseToggle flag={key} label={FLAG_LABELS[key].label} enabled={flags[key]} />
            </li>
          ))}
        </ul>
      </Card>
      <p className="mt-4 text-sm text-ink-500">
        Before switching on: Meta templates approved (customer WhatsApp), Razorpay test keys and verified payout accounts
        (online payments), a Turnstile key and the privacy policy updated (marketplace, growth). See docs/DECISIONS.md D-180.
      </p>
    </main>
  );
}
