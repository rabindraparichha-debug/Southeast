-- Vendor-first wave 3 (riders track), audit item 26 (rest): minimum app version.
--
-- platform_settings row 'min_app_version': enabled = the gate is on; value = {"version": "1.2.0",
-- "android_url": "https://...", "ios_url": "https://...", "message": "..."}. The mobile app reads it
-- through app_config() (also before login: an old build may not be able to log in any more), and
-- shows "Update required" only once its rider queue has been sent.
insert into public.platform_settings (key, enabled, value) values ('min_app_version', false, '{}')
on conflict (key) do nothing;

-- Public app settings (no secrets). Anon: the gate runs before login too.
create or replace function public.app_config()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'min_app_version', case when s.enabled then s.value ->> 'version' end,
    'android_url', s.value ->> 'android_url',
    'ios_url', s.value ->> 'ios_url',
    'message', s.value ->> 'message')
  from (select coalesce((select enabled from public.platform_settings where key = 'min_app_version'), false) as enabled,
               coalesce((select value from public.platform_settings where key = 'min_app_version'), '{}'::jsonb) as value) s;
$$;

-- Platform admin: set (or with a null/empty version, switch off) the minimum version.
create or replace function public.admin_set_min_app_version(p_version text, p_android_url text default null,
                                                            p_ios_url text default null, p_message text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version text := nullif(trim(p_version), '');
begin
  perform private.require_admin();
  if v_version is not null and v_version !~ '^\d{1,3}(\.\d{1,3}){0,2}$' then
    raise exception 'invalid_version' using errcode = '22023';
  end if;
  if (nullif(trim(p_android_url), '') is not null and (trim(p_android_url) !~ '^https://\S{3,}$' or length(trim(p_android_url)) > 500))
     or (nullif(trim(p_ios_url), '') is not null and (trim(p_ios_url) !~ '^https://\S{3,}$' or length(trim(p_ios_url)) > 500)) then
    raise exception 'invalid_url' using errcode = '22023';
  end if;
  insert into public.platform_settings (key, enabled, value, updated_by)
  values ('min_app_version', v_version is not null,
          jsonb_strip_nulls(jsonb_build_object('version', v_version, 'android_url', nullif(trim(p_android_url), ''),
            'ios_url', nullif(trim(p_ios_url), ''), 'message', left(nullif(trim(p_message), ''), 300))),
          auth.uid())
  on conflict (key) do update
    set enabled = excluded.enabled, value = excluded.value, updated_by = excluded.updated_by;
  return public.app_config();
end;
$$;

revoke execute on function public.app_config, public.admin_set_min_app_version from public, anon, authenticated;
grant execute on function public.app_config to anon, authenticated;
grant execute on function public.admin_set_min_app_version to authenticated;
