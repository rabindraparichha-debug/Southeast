// Shapes of the admin escalation RPCs (D-152).
export type EscalationStatus = 'escalated' | 'open' | 'resolved';

export type TeamMember = { id: string; name: string; me: boolean };

export type EscalatedComplaint = {
  id: string;
  category: string;
  description: string | null;
  photo_url: string | null;
  channel: 'whatsapp' | 'web' | 'vendor';
  status: 'open' | 'responded' | 'resolved' | 'escalated';
  created_at: string;
  escalated_at: string | null;
  responded_at: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  hours_open: number;
  meal: { date: string; slot: 'lunch' | 'dinner' } | null;
  kitchen: { id: string; name: string; area: string | null; status: string; owner_name: string | null; owner_phone_masked: string | null };
  customer: { id: string; name: string; phone_masked: string; platform_sourced: boolean };
  assigned_to: { id: string; name: string; at: string } | null;
  resolved_by: string | null;
};

export type EscalationQueue = { complaints: EscalatedComplaint[]; team: TeamMember[] };

export type ComplaintDetail = {
  complaint: {
    id: string; category: string; description: string | null; photo_url: string | null; channel: string; status: string;
    created_at: string; escalated_at: string | null; resolved_at: string | null; resolution_note: string | null;
    assigned_admin_id: string | null;
  };
  kitchen: EscalatedComplaint['kitchen'];
  customer: {
    id: string; name: string; phone_masked: string; platform_sourced: boolean; since: string; balance_meals: number; complaints_90d: number;
    subscriptions: { plan: string; status: string; slots: string[]; price_per_meal_paise: number }[];
  };
  meal: { date: string; slot: string; status: string } | null;
  messages: { at: string; direction: 'in' | 'out'; body: string | null; handled_by: string }[];
  events: { at: string; action: string; note: string | null; admin: string | null }[];
};

export const CATEGORY_LABEL: Record<string, string> = {
  late: 'Late', quality: 'Quality', quantity: 'Quantity', missing: 'Missing item', hygiene: 'Hygiene', delivery: 'Delivery',
  billing: 'Billing', privacy: 'Privacy', other: 'Other',
};
