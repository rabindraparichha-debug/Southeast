import type { MemberRole } from '@tiffin/db';

// Who sees what on the web dashboard (D-117, D-119). The database is the real gate (RLS and
// private.require_role); these lists only decide which pages and buttons are shown.
//
// - Manager = the owner's deputy: everything the owner sees, except the owner-only areas
//   (inbox, kitchen settings, team, payouts, commission, audit log).
// - Accountant = reads money (customers with masked phones, ledger, payments, statements,
//   bills, exports, register, costs). No writes, no addresses, no kitchen orders.
// - Staff and riders are unchanged.

/** Owner-level pages and actions (owner and manager). */
export const LEAD_ROLES: MemberRole[] = ['owner', 'manager'];
/** Money pages (read for the accountant, read and write for owner and manager). */
export const MONEY_ROLES: MemberRole[] = ['owner', 'manager', 'accountant'];
/** Kitchen work: counts, kitchen sheet, delivery, menu, inventory. */
export const KITCHEN_ROLES: MemberRole[] = ['owner', 'manager', 'staff'];
/** The customer list (staff: names and areas only; accountant: names and masked phones). */
export const CUSTOMER_ROLES: MemberRole[] = ['owner', 'manager', 'staff', 'accountant'];

/** Owner or manager: owner-level actions (money writes, customer changes, full phone numbers). */
export const isLead = (role: MemberRole | null | undefined) => role === 'owner' || role === 'manager';
/** Can read money (owner, manager, accountant). */
export const canReadMoney = (role: MemberRole | null | undefined) => isLead(role) || role === 'accountant';
