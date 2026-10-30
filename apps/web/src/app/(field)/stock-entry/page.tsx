import type { Metadata } from 'next';
import { requireKitchen } from '@/lib/session';
import { StockEntry } from './stock-entry';

export const metadata: Metadata = { title: 'Stock entry · Tiffin OS' };

// Quick stock entry on the phone (owner + staff): purchases, waste and stock-takes. The full
// inventory pages (/inventory) hold suppliers, recipes, costs and history.
export default async function StockEntryPage() {
  const { kitchen } = await requireKitchen(['owner', 'staff']);
  return <StockEntry kitchenId={kitchen.kitchenId} isOwner={kitchen.role === 'owner'} />;
}
