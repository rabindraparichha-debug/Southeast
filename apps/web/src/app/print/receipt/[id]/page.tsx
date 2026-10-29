import { notFound } from 'next/navigation';
import { formatPaise, formatPhone } from '@tiffin/core';
import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { PrintButton } from '@/components/print-button';
import { METHOD_LABEL } from '@/components/payment-badges';

export default async function ReceiptPage({ params }: PageProps<'/print/receipt/[id]'>) {
  const { id } = await params;
  const { kitchen } = await requireKitchen(['owner']);
  const supabase = await createClient();
  const { data: p } = await supabase.from('payments').select('id, customer_id, method, status, amount_paise, meals, paid_at, created_at, razorpay_payment_id')
    .eq('id', id).eq('kitchen_id', kitchen.kitchenId).maybeSingle();
  if (!p || p.status !== 'paid') notFound();
  const [{ data: k }, { data: c }, { data: bal }] = await Promise.all([
    supabase.from('kitchens').select('name, address, area, city, fssai_no').eq('id', kitchen.kitchenId).single(),
    supabase.from('customers_v').select('name, phone').eq('id', p.customer_id).single(),
    supabase.from('customer_balances').select('meals').eq('customer_id', p.customer_id).maybeSingle(),
  ]);
  const when = new Date(p.paid_at ?? p.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="mx-auto max-w-md rounded-xl p-6 ring-1 ring-ink-200 print:ring-0">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-lg font-semibold">{k?.name}</h1>
          <p className="text-xs text-ink-500">{[k?.address, k?.area, k?.city].filter(Boolean).join(', ')}</p>
          {k?.fssai_no && <p className="text-xs text-ink-500">FSSAI {k.fssai_no}</p>}
        </div>
        <PrintButton />
      </div>
      <h2 className="mt-6 text-sm font-semibold uppercase tracking-wide text-ink-500">Payment receipt</h2>
      <dl className="mt-2 grid grid-cols-2 gap-y-1.5 text-sm">
        <dt className="text-ink-500">Receipt no.</dt><dd>{p.id.slice(0, 8).toUpperCase()}</dd>
        <dt className="text-ink-500">Date</dt><dd>{when}</dd>
        <dt className="text-ink-500">Customer</dt><dd>{c?.name}</dd>
        <dt className="text-ink-500">Phone</dt><dd>{formatPhone(c?.phone)}</dd>
        <dt className="text-ink-500">Paid by</dt><dd>{METHOD_LABEL[p.method] ?? p.method}{p.razorpay_payment_id ? ` (${p.razorpay_payment_id})` : ''}</dd>
        <dt className="text-ink-500">Meals</dt><dd>{p.meals}</dd>
        <dt className="text-ink-500">Amount</dt><dd className="text-lg font-semibold">{formatPaise(p.amount_paise)}</dd>
        <dt className="text-ink-500">Balance now</dt><dd>{bal?.meals ?? 0} meals</dd>
      </dl>
      <p className="mt-6 text-xs text-ink-500">Unused prepaid meals are refunded at the price paid when a subscription is cancelled. Thank you!</p>
    </div>
  );
}
