import type { MemberRole } from '@tiffin/db';

// Who sees what in the app (D-117, D-156). The database is the real gate (RLS and
// private.require_role); these helpers only decide which screens and buttons are shown.
// Same lists as apps/web/src/lib/roles.ts.
//
// - Manager = the owner's deputy: customer changes, new customers, payments, confirming rider cash,
//   approving rider requests, delivery and stock. Not the owner-only areas (inbox, settings, team).
// - Accountant = reads money (customers with masked phones, balances, payments, dues). No writes,
//   no addresses, no kitchen orders.
// - Staff and riders are unchanged.

type Role = MemberRole | null | undefined;

/** Owner or manager: owner-level actions (money writes, customer changes, full phone numbers). */
export const isLead = (role: Role) => role === 'owner' || role === 'manager';
/** Can read money (owner, manager, accountant). */
export const canReadMoney = (role: Role) => isLead(role) || role === 'accountant';
/** Kitchen work: counts, packing list, stock (owner, manager, staff). */
export const isKitchen = (role: Role) => isLead(role) || role === 'staff';
/** Can deliver (riders, and owners or managers who deliver themselves). */
export const canDeliver = (role: Role) => isLead(role) || role === 'rider';
