// Step 2 of every payment link (owner, customer page, payer, WhatsApp bot): ask Razorpay for the link
// and attach it to our 'created' payment row. If that fails, the row is cancelled
// (cancel_payment_link_record, service role) so no unpaid, link-less row is left behind (D-129).
// No external imports: unit-tested from Node.

export type CancelRecord = (paymentId: string, error: string) => Promise<unknown>;

/** Short reason kept on the payment row: the error code, never a stack or a secret. */
export function failureReason(e: unknown): string {
  const msg = String((e as Error)?.message ?? e ?? 'gateway_error');
  return (msg.split(/[\s:]/)[0] || 'gateway_error').slice(0, 60);
}

/**
 * Runs create(); on failure cancels the payment row and rethrows the original error (the caller
 * still answers gateway_error). A failure to cancel is reported but never hides the original error.
 */
export async function createLinkOrCancel<T>(
  paymentId: string,
  create: () => Promise<T>,
  cancel: CancelRecord,
  report?: (e: unknown) => void,
): Promise<T> {
  try {
    return await create();
  } catch (e) {
    try {
      await cancel(paymentId, failureReason(e));
    } catch (cancelError) {
      report?.(cancelError);
    }
    throw e;
  }
}
