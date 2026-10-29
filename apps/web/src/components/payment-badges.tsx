import { Badge } from './ui';

export const METHOD_LABEL: Record<string, string> = {
  razorpay_link: 'Online (link)', razorpay_autopay: 'Autopay', cash: 'Cash', upi_manual: 'UPI to vendor', bank_transfer: 'Bank transfer',
};
const PAYMENT_TONE = { created: 'blue', pending: 'amber', paid: 'green', failed: 'red', expired: 'gray', cancelled: 'gray', review: 'red' } as const;
const PAYMENT_LABEL = { created: 'Link sent', pending: 'To confirm', paid: 'Paid', failed: 'Failed', expired: 'Expired', cancelled: 'Cancelled', review: 'Check amount' } as const;
const REFUND_TONE = { pending: 'amber', processing: 'blue', processed: 'green', failed: 'red' } as const;
const REFUND_LABEL = { pending: 'To pay', processing: 'Processing', processed: 'Refunded', failed: 'Failed' } as const;

export function PaymentStatus({ status }: { status: keyof typeof PAYMENT_TONE }) {
  return <Badge tone={PAYMENT_TONE[status]}>{PAYMENT_LABEL[status]}</Badge>;
}
export function RefundStatus({ status }: { status: keyof typeof REFUND_TONE }) {
  return <Badge tone={REFUND_TONE[status]}>{REFUND_LABEL[status]}</Badge>;
}
