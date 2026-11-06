-- Vendor-first wave 3 (safety), audit item 41 (part): "verified" is separate from "listed".
--
-- Before, the only state above draft was 'active' (listed): publishing the kitchen, opening it to
-- marketplace matching and meaning "the platform checked its FSSAI" all at once.
--
--   * kitchens.verified_at / verified_by / verification_note: the platform team checked the FSSAI
--     certificate (admin_verify_kitchen). A verified kitchen can stay private (draft) forever.
--   * Listing (status 'active') needs a verified kitchen when a person does it ('not_verified');
--     kitchens already listed are backfilled as verified (the team checked them before listing).
--   * Once verified, the owner can no longer change the FSSAI number (it used to lock only once
--     listed, so it could change between the check and listing); the platform team still can.
--   * Un-verifying a listed kitchen is refused ('kitchen_listed'): make it private first.

alter table public.kitchens
  add column verified_at timestamptz,
  add column verified_by uuid references auth.users (id),
  add column verification_note text check (verification_note is null or length(verification_note) <= 500);

update public.kitchens set verified_at = coalesce(updated_at, now()) where status = 'active' and verified_at is null;

create or replace function private.guard_fssai()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (old.status = 'active' or old.verified_at is not null) and new.fssai_no is distinct from old.fssai_no
     and auth.uid() is not null and auth.role() <> 'service_role' and not private.is_platform_admin() then
    raise exception 'fssai_locked' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- Listing by a person (the admin screen) needs verification first. Database maintenance and the
-- local seed (no signed-in user) are not checked.
create or replace function private.guard_listing()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'active' and old.status is distinct from 'active' and new.verified_at is null
     and auth.uid() is not null and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'not_verified' using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger kitchens_listing_guard before update of status on public.kitchens
  for each row execute function private.guard_listing();

create or replace function public.admin_verify_kitchen(p_kitchen uuid, p_verified boolean, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_k public.kitchens;
begin
  perform private.require_admin();
  select * into v_k from public.kitchens where id = p_kitchen for update;
  if v_k.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if coalesce(p_verified, false) then
    if v_k.fssai_no is null then
      raise exception 'fssai_required' using errcode = '22023';
    end if;
    update public.kitchens
    set verified_at = coalesce(verified_at, private.now()), verified_by = coalesce(verified_by, auth.uid()),
        verification_note = coalesce(nullif(trim(p_note), ''), verification_note)
    where id = p_kitchen;
  else
    if v_k.status = 'active' then
      raise exception 'kitchen_listed' using errcode = '22023';
    end if;
    update public.kitchens set verified_at = null, verified_by = null, verification_note = nullif(trim(p_note), '')
    where id = p_kitchen;
  end if;
  return (select jsonb_build_object('id', k.id, 'verified_at', k.verified_at, 'verified_by', k.verified_by,
                                    'verification_note', k.verification_note, 'status', k.status)
          from public.kitchens k where k.id = p_kitchen);
end;
$$;

revoke execute on function public.admin_verify_kitchen from public, anon;
grant execute on function public.admin_verify_kitchen to authenticated;
revoke execute on function private.guard_listing from public, anon, authenticated;
