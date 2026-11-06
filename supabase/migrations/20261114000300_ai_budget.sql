-- Phase 2 hardening, step 3: a budget for the AI chat fallback (docs/VENDOR_FIRST_AUDIT.md, Phase 2
-- step 5, "the AI fallback has no cost cap"; D-148).
--
-- One row per IST day and conversation counts the model calls the webhook made. wa_ai_take() is
-- asked before every call and either takes one unit (true) or refuses (false) when the conversation
-- or the whole platform has used its cap for the day. The caps come from the Edge Function's env
-- (AI_CONVERSATION_DAILY_CAP, AI_DAILY_CAP), so they can change without a migration. Over the cap the
-- bot answers from its rules (cutoffs, FSSAI, price) and hands everything else to the kitchen.

create table public.ai_usage (
  day date not null,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  kitchen_id uuid references public.kitchens (id) on delete cascade,
  calls integer not null default 0 check (calls >= 0),
  updated_at timestamptz not null default now(),
  primary key (day, conversation_id)
);
create index ai_usage_day_idx on public.ai_usage (day);

alter table public.ai_usage enable row level security;
-- The platform team can see the spend; nobody writes directly.
create policy ai_usage_select on public.ai_usage for select to authenticated using ((select private.is_platform_admin()));
revoke all on public.ai_usage from anon, authenticated;
grant select on public.ai_usage to authenticated;

-- Service role (whatsapp-webhook): one AI call for this conversation, if both caps allow it.
create or replace function public.wa_ai_take(p_conversation uuid, p_conversation_cap integer, p_day_cap integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := private.ist_today();
  v_kitchen uuid;
  v_mine integer;
  v_total integer;
begin
  if coalesce(p_conversation_cap, 0) <= 0 or coalesce(p_day_cap, 0) <= 0 then
    return false;
  end if;
  select kitchen_id into v_kitchen from public.conversations where id = p_conversation;
  if not found then
    return false;
  end if;
  -- One caller at a time per day, so two messages at once cannot both take the last unit.
  perform pg_advisory_xact_lock(hashtext('tiffin.ai_usage'), (v_day - date '2026-01-01'));
  select coalesce(sum(calls), 0) into v_total from public.ai_usage where day = v_day;
  select coalesce(calls, 0) into v_mine from public.ai_usage where day = v_day and conversation_id = p_conversation;
  if coalesce(v_mine, 0) >= p_conversation_cap or v_total >= p_day_cap then
    return false;
  end if;
  insert into public.ai_usage (day, conversation_id, kitchen_id, calls, updated_at)
  values (v_day, p_conversation, v_kitchen, 1, private.now())
  on conflict (day, conversation_id) do update set calls = public.ai_usage.calls + 1, updated_at = excluded.updated_at;
  return true;
end;
$$;

revoke execute on function public.wa_ai_take(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.wa_ai_take(uuid, integer, integer) to service_role;
