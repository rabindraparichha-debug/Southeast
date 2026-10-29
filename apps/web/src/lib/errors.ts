// Database functions raise short codes; this turns them into vendor-facing English.
// Wording here is a draft for the owner to review (docs/DECISIONS.md D-012).
const MESSAGES: Record<string, string> = {
  forbidden: 'You do not have permission to do this.',
  not_authenticated: 'Please log in again.',
  not_found: 'This record no longer exists.',
  invalid_phone: 'Enter a valid 10-digit Indian mobile number.',
  already_exists: 'A customer with this phone number already exists in your kitchen.',
  already_member: 'This person is already in your team.',
  consent_required: 'Please confirm the customer agreed to be contacted.',
  name_required: 'Name is required.',
  slug_taken: 'That web address is already taken. Try another.',
  cannot_invite_owner: 'A kitchen can have only one owner.',
  owner_role_locked: "The owner's role cannot be changed here.",
  has_live_subscription: 'Cancel this customer’s subscriptions before deleting their data.',
  invalid_initial_status: 'New subscriptions can only start as Trial or Active.',
  too_many_rows: 'Import at most 2,000 rows at a time.',
  date_in_past: 'Choose today or a later date.',
  date_required: 'Choose a date.',
  invalid_range: 'The end date must be on or after the start date.',
  range_too_long: 'Choose a range of 90 days or less.',
  slot_not_in_plan: 'This plan does not include that meal.',
  slot_not_allowed: 'Cancellation applies to all meals.',
  invalid_address: 'Choose one of this customer’s addresses.',
  subscription_cancelled: 'This subscription is already cancelled.',
  payout_account_not_verified: 'Online payments start once your Razorpay payout account is verified. Record cash or UPI meanwhile.',
  invalid_meals: 'Enter a valid number of meals.',
  invalid_amount: 'Enter a valid amount.',
  invalid_method: 'Choose cash, UPI or bank transfer.',
  no_plan: 'Add a subscription first so the price per meal is known.',
  not_pending: 'This was already handled.',
  nothing_to_refund: 'There are no unused meals to refund.',
  refund_exceeds_balance: 'That is more meals than the customer has left.',
  no_online_payment: 'This refund cannot go back online (no matching online payment). Pay it in cash or UPI.',
  refund_exceeds_payment: 'The online payment is smaller than this refund. Pay it in cash or UPI.',
  reason_required: 'Please give a reason.',
  invalid_type: 'Choose credit or adjustment.',
  gateway_error: 'The payment gateway did not respond. Try again in a minute.',
  invalid_account_id: 'Razorpay account ids look like acc_XXXXXXXX.',
  live_keys_not_approved: 'Razorpay live mode is not approved yet.',
  broadcast_cap_reached: 'You have used all announcements for this month.',
  invalid_message: 'Write a message of up to 1,000 characters.',
  invalid_link: 'This link has expired.',
  cancel_via_kitchen: 'Cancellations are handled by the kitchen.',
};

export function friendlyError(error: { message?: string; code?: string } | null | undefined): string {
  if (!error) return '';
  const msg = error.message ?? '';
  if (MESSAGES[msg]) return MESSAGES[msg];
  if (error.code === '23514') return 'One of the values is not allowed. Please check the form.';
  if (error.code === '23505') return 'This already exists.';
  if (error.code === '42501') return MESSAGES.forbidden!;
  return msg || 'Something went wrong. Please try again.';
}
