import Link from 'next/link';
import { formatIstShort } from '@tiffin/core';
import { requireKitchen } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import { Badge, Card, PageHeader } from '@/components/ui';
import { Thread } from './thread';
import { BroadcastForm } from './broadcast-form';

export default async function InboxPage({ searchParams }: PageProps<'/inbox'>) {
  const { kitchen } = await requireKitchen(['owner']);
  const sp = await searchParams;
  const supabase = await createClient();

  const [{ data: convs }, { data: recent }, { data: complaints }, { data: settings }, { count: broadcastsThisMonth }] = await Promise.all([
    supabase.from('conversations').select('id, customer_id, contact_name, phone_last4, handoff_open, unread_count, last_message_at')
      .eq('kitchen_id', kitchen.kitchenId).not('last_message_at', 'is', null).order('last_message_at', { ascending: false }).limit(100),
    supabase.from('messages').select('conversation_id, body, direction, created_at')
      .eq('kitchen_id', kitchen.kitchenId).order('created_at', { ascending: false }).limit(400),
    supabase.from('complaints').select('id, conversation_id, customer_id, category, description, status, created_at, photo_url')
      .eq('kitchen_id', kitchen.kitchenId).in('status', ['open', 'escalated', 'responded']).order('created_at'),
    supabase.from('kitchen_settings').select('broadcast_cap_monthly').eq('kitchen_id', kitchen.kitchenId).single(),
    supabase.from('broadcasts').select('id', { count: 'exact', head: true }).eq('kitchen_id', kitchen.kitchenId)
      .gte('created_at', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()),
  ]);
  const ids = [...new Set((convs ?? []).map((c) => c.customer_id).filter(Boolean))] as string[];
  const { data: names } = ids.length ? await supabase.from('customers_v').select('id, name').in('id', ids) : { data: [] };
  const nameOf = new Map((names ?? []).map((n) => [n.id, n.name]));
  const last = new Map<string, { body: string | null; direction: string }>();
  for (const m of recent ?? []) if (!last.has(m.conversation_id)) last.set(m.conversation_id, m);
  const openByConv = new Map<string, number>();
  for (const c of complaints ?? []) if (c.conversation_id && c.status !== 'responded') openByConv.set(c.conversation_id, (openByConv.get(c.conversation_id) ?? 0) + 1);

  const selectedId = typeof sp.c === 'string' ? sp.c : convs?.[0]?.id;
  const selected = (convs ?? []).find((c) => c.id === selectedId);
  const { data: thread } = selected
    ? await supabase.from('messages').select('id, direction, body, handled_by, status, created_at').eq('conversation_id', selected.id).order('created_at').limit(200)
    : { data: [] };

  return (
    <>
      <PageHeader title="Inbox" subtitle="Customer messages from WhatsApp. The bot answers first; anything it can’t handle comes here." />
      <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
        <Card className="max-h-[75vh] overflow-y-auto p-0">
          <ul className="divide-y divide-ink-100">
            {(convs ?? []).map((c) => {
              const lm = last.get(c.id);
              const name = (c.customer_id && nameOf.get(c.customer_id)) || c.contact_name || `•••${c.phone_last4}`;
              return (
                <li key={c.id}>
                  <Link href={`/inbox?c=${c.id}`} className={`block px-4 py-3 text-sm hover:bg-ink-50 ${c.id === selectedId ? 'bg-brand-50' : ''}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{name}</span>
                      <span className="shrink-0 text-xs text-ink-500">{c.last_message_at ? formatIstShort(c.last_message_at) : ''}</span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5">
                      <span className="truncate text-xs text-ink-500">{lm ? `${lm.direction === 'out' ? '↩ ' : ''}${(lm.body ?? '').split('\n')[0]}` : ''}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {c.unread_count > 0 && <Badge tone="blue">{c.unread_count} new</Badge>}
                      {c.handoff_open && <Badge tone="amber">Needs reply</Badge>}
                      {openByConv.get(c.id) ? <Badge tone="red">Complaint</Badge> : null}
                    </div>
                  </Link>
                </li>
              );
            })}
            {(convs ?? []).length === 0 && <li className="px-4 py-8 text-center text-sm text-ink-500">No WhatsApp messages yet. Invite customers from their page.</li>}
          </ul>
        </Card>

        <div className="space-y-4">
          {selected ? (
            <Thread
              conversationId={selected.id}
              customerId={selected.customer_id}
              title={(selected.customer_id && nameOf.get(selected.customer_id)) || selected.contact_name || `•••${selected.phone_last4}`}
              handoffOpen={selected.handoff_open}
              unread={selected.unread_count}
              messages={thread ?? []}
              complaints={(complaints ?? []).filter((c) => c.conversation_id === selected.id || c.customer_id === selected.customer_id)}
            />
          ) : (
            <Card><p className="text-sm text-ink-500">Select a conversation.</p></Card>
          )}
          <BroadcastForm kitchenId={kitchen.kitchenId} cap={settings?.broadcast_cap_monthly ?? 4} used={broadcastsThisMonth ?? 0} />
        </div>
      </div>
    </>
  );
}
