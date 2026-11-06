// Step 2 of every payment link (owner, customer page, payer, WhatsApp bot): ask Razorpay for the link
// and attach it to our 'created' payment row (D-129, D-135).
//   * Razorpay did not create a link: the row is cancelled (cancel_payment_link_record, service role),
//     so no unpaid, link-less row is left behind.
//   * Razorpay created a link but attaching it failed: attaching is retried; if it still fails, the
//     link is cancelled at Razorpay first, and only once that worked is our row cancelled. If the
//     link cannot be cancelled either, our row stays 'created' (a live link exists; a payment on it is
//     still credited from the webhook through its payment_id) and the failure is reported.
// No external imports: unit-tested from Node.

export type CancelRecord = (paymentId: string, error: string) => Promise<unknown>;

export type LinkSteps<L> = {
  /** Asks Razorpay (or the mock) for the link. */
  create: () => Promise<L>;
  /** Attaches the created link to our payment row. */
  attach: (link: L) => Promise<void>;
  /** Cancels the created link at Razorpay, when attaching it failed for good. */
  cancelGateway: (link: L) => Promise<void>;
};

/** Short reason kept on the payment row: the error code, never a stack or a secret. */
export function failureReason(e: unknown): string {
  const msg = String((e as Error)?.message ?? e ?? 'gateway_error');
  return (msg.split(/[\s:]/)[0] || 'gateway_error').slice(0, 60);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs the steps; on failure rethrows the original error (the caller still answers gateway_error).
 * A failure to cancel is reported but never hides the original error.
 */
export async function createLinkOrCancel<L>(
  paymentId: string,
  steps: LinkSteps<L>,
  cancel: CancelRecord,
  report?: (e: unknown) => void,
  opts: { attachTries?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<L> {
  const cancelRow = async (reason: string) => {
    try {
      await cancel(paymentId, reason);
    } catch (cancelError) {
      report?.(cancelError);
    }
  };

  let link: L;
  try {
    link = await steps.create();
  } catch (e) {
    await cancelRow(failureReason(e));
    throw e;
  }

  const tries = Math.max(1, opts.attachTries ?? 3);
  const sleep = opts.sleep ?? defaultSleep;
  let attachError: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      await steps.attach(link);
      return link;
    } catch (e) {
      attachError = e;
      if (i < tries - 1) await sleep(250 * (i + 1));
    }
  }

  // The link exists at Razorpay. Cancel it there before calling our row failed.
  try {
    await steps.cancelGateway(link);
  } catch (gatewayError) {
    report?.(gatewayError);
    throw attachError;
  }
  await cancelRow(`attach_failed_${failureReason(attachError)}`.slice(0, 60));
  throw attachError;
}
