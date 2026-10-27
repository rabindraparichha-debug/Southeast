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
