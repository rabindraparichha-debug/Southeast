'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/errors';
import type { CustomerScore } from '@/lib/p5';
import { Alert, Badge, Button, Card, Input } from '@/components/ui';

// Referral code (P5) and the customer's complaint score. Owner only.
export function ReferralCard({ customerId, code, referredBy, canApply, rewardMeals, score }: {
  customerId: string;
  code: string | null;
  referredBy: string | null;
  canApply: boolean;
  rewardMeals: number;
  score: CustomerScore | null;
}) {
  const router = useRouter();
  const [input, setInput] = useState('');
  const [msg, setMsg] = useState<{ tone: 'red' | 'green'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function apply() {
    setBusy(true);
    setMsg(null);
    const { error } = await supabaseBrowser().rpc('apply_referral_code', { p_customer: customerId, p_code: input.trim() });
    setBusy(false);
    if (error) return setMsg({ tone: 'red', text: friendlyError(error) });
    setInput('');
    setMsg({ tone: 'green', text: 'Referral linked. The reward follows their first payment.' });
    router.refresh();
  }

  return (
    <Card title="Referrals and complaints">
      <div className="space-y-4 text-sm">
        <div>
          <p className="text-ink-600">Their referral code</p>
          <p className="font-mono text-lg font-semibold tracking-wider" data-testid="referral-code">{code ?? '—'}</p>
          <p className="text-xs text-ink-500">
            {rewardMeals > 0
              ? `A friend who joins with this code and pays gets ${rewardMeals} free meal${rewardMeals === 1 ? '' : 's'}, and so does this customer.`
              : 'Referral rewards are off. Set the reward meals in Kitchen settings.'}
          </p>
        </div>

        <div className="border-t border-ink-100 pt-4">
          {referredBy ? (
            <p>Joined with a code from <strong>{referredBy}</strong>.</p>
          ) : canApply ? (
            <div className="space-y-2">
              <p className="font-medium text-ink-800">Joined with a friend’s code?</p>
              <div className="flex gap-2">
                <Input value={input} onChange={(e) => setInput(e.target.value.toUpperCase())} placeholder="8-letter code" maxLength={20} className="font-mono" aria-label="Referral code" />
                <Button variant="secondary" onClick={apply} disabled={busy || input.trim().length < 6}>Apply</Button>
              </div>
            </div>
          ) : (
            <p className="text-ink-500">Referral codes can only be added before the first payment.</p>
          )}
        </div>

        {score && (
          <div className="border-t border-ink-100 pt-4">
            <p className="font-medium text-ink-800">Complaints (last {score.days} days)</p>
            <p className="mt-1">
              <strong>{score.complaints}</strong> complaint{score.complaints === 1 ? '' : 's'} for {score.meals} meals
              {score.complaints_per_100_meals != null && <> · {score.complaints_per_100_meals} per 100 meals</>}
            </p>
            {score.first_complaint_credited && <div className="mt-1"><Badge tone="green">First complaint credited (1 free meal)</Badge></div>}
          </div>
        )}
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      </div>
    </Card>
  );
}
