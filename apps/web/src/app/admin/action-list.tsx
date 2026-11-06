import type { AdminActionRow } from '@tiffin/db';
import { istDateTime } from '@/lib/public';

// The admin_actions log as a list (wave 4): kitchen detail and the Access page.
const ACTION_LABEL: Record<string, string> = {
  vendor_approved: 'Application approved', vendor_unapproved: 'Approval withdrawn', vendor_phone_allowed: 'Number allowed to create a kitchen',
  vendor_phone_removed: 'Allowed number removed', phone_revealed: 'Phone number revealed', member_phone_changed: 'Login phone changed',
  ownership_transferred: 'Ownership transferred', platform_admin_added: 'Platform admin added', platform_admin_removed: 'Platform admin removed',
  close_request_closed: 'Close request done', close_request_declined: 'Close request declined',
};

function actionDetail(a: AdminActionRow): string {
  const before = a.before ?? {};
  const after = a.after ?? {};
  const parts: string[] = [];
  if (typeof before.phone_last4 === 'string' && typeof after.phone_last4 === 'string') parts.push(`••${before.phone_last4} → ••${after.phone_last4}`);
  else if (typeof after.phone_last4 === 'string') parts.push(`••${after.phone_last4}`);
  if (typeof after.old_owner === 'string') parts.push(after.old_owner === 'remove' ? 'old owner removed' : 'old owner now staff');
  if (after.signed_out === true) parts.push('signed out everywhere');
  return parts.join(' · ');
}

export function ActionList({ actions, showKitchen }: { actions: (AdminActionRow & { kitchen?: string | null })[]; showKitchen?: boolean }) {
  if (!actions.length) return <p className="text-sm text-ink-500">Nothing yet.</p>;
  return (
    <ul className="divide-y divide-ink-100 text-sm">
      {actions.map((a) => (
        <li key={a.id} className="py-2">
          <div className="flex flex-wrap gap-2">
            <span className="font-medium">{ACTION_LABEL[a.action] ?? a.action}</span>
            {showKitchen && a.kitchen && <span className="text-ink-700">{a.kitchen}</span>}
            <span className="text-ink-500">{actionDetail(a)}</span>
          </div>
          <div className="text-xs text-ink-500">
            {istDateTime(a.at)}{a.admin_phone_last4 ? ` · by admin ••${a.admin_phone_last4}` : ''}{a.reason ? ` · “${a.reason}”` : ''}
          </div>
        </li>
      ))}
    </ul>
  );
}
