-- Local development seed. Runs after migrations on `supabase db reset`.
-- NEVER run against production: it creates fixed users and dev-only encryption keys.
--
-- Logins (OTP is always 123456 locally, see supabase/config.toml [auth.sms.test_otp]):
--   Kitchen A "Maa Tarini Tiffin" (Patia):      owner +919000000001, staff +919000000002, rider +919000000003
--   Kitchen B "Saheed Nagar Mess" (Saheed Nagar): owner +919000000011, staff +919000000012, rider +919000000013
--   Platform admin: +919000000099
--   Spare numbers for sign-up / invite tests: +919000000100 (pending rider invite to A), +919000000101, +919000000102

-- Dev-only keys. Production keys are created once per project (see CLAUDE.md > Secrets).
select vault.create_secret('local-dev-phone-encryption-key-NOT-FOR-PRODUCTION', 'phone_encryption_key');
select vault.create_secret('local-dev-phone-hash-key-NOT-FOR-PRODUCTION', 'phone_hash_key');

-- ---------------------------------------------------------------------------
-- Auth users (phone login)
-- ---------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, phone, phone_confirmed_at, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new,
  email_change, email_change_token_current, reauthentication_token, phone_change, phone_change_token)
select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.phone, now(),
  '{"provider":"phone","providers":["phone"]}', jsonb_build_object('name', u.name), now(), now(),
  '', '', '', '', '', '', '', ''
from (values
  ('00000000-0000-4000-a000-000000000001'::uuid, '919000000001', 'Sunita Mohanty'),
  ('00000000-0000-4000-a000-000000000002'::uuid, '919000000002', 'Rina Behera'),
  ('00000000-0000-4000-a000-000000000003'::uuid, '919000000003', 'Bapi Rout'),
  ('00000000-0000-4000-a000-000000000011'::uuid, '919000000011', 'Pradeep Sahu'),
  ('00000000-0000-4000-a000-000000000012'::uuid, '919000000012', 'Mamata Das'),
  ('00000000-0000-4000-a000-000000000013'::uuid, '919000000013', 'Raju Nayak'),
  ('00000000-0000-4000-a000-000000000099'::uuid, '919000000099', 'Platform Admin')
) as u(id, phone, name);

insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
select gen_random_uuid(), u.id, u.id::text, 'phone',
  jsonb_build_object('sub', u.id::text, 'phone', u.phone, 'phone_verified', true), now(), now(), now()
from auth.users u
where u.id::text like '00000000-0000-4000-a000-%';

insert into public.platform_admins (user_id) values ('00000000-0000-4000-a000-000000000099');

-- ---------------------------------------------------------------------------
-- Kitchens
-- ---------------------------------------------------------------------------
insert into public.kitchens (id, name, slug, owner_id, address, area, lat, lng, service_radius_km, fssai_no,
  capacity_lunch, capacity_dinner, weekly_off)
values
  ('10000000-0000-4000-a000-00000000000a', 'Maa Tarini Tiffin', 'maa-tarini-tiffin',
   '00000000-0000-4000-a000-000000000001', 'Plot 214, Patia Main Road', 'Patia', 20.3553, 85.8197, 3,
   '12026001000123', 80, 40, '{7}'),
  ('10000000-0000-4000-a000-00000000000b', 'Saheed Nagar Mess', 'saheed-nagar-mess',
   '00000000-0000-4000-a000-000000000011', 'N-3/45, Saheed Nagar', 'Saheed Nagar', 20.2900, 85.8450, 3,
   null, 40, 40, '{}');

insert into public.members (kitchen_id, user_id, role, display_name) values
  ('10000000-0000-4000-a000-00000000000a', '00000000-0000-4000-a000-000000000001', 'owner', 'Sunita Mohanty'),
  ('10000000-0000-4000-a000-00000000000a', '00000000-0000-4000-a000-000000000002', 'staff', 'Rina Behera'),
  ('10000000-0000-4000-a000-00000000000a', '00000000-0000-4000-a000-000000000003', 'rider', 'Bapi Rout'),
  ('10000000-0000-4000-a000-00000000000b', '00000000-0000-4000-a000-000000000011', 'owner', 'Pradeep Sahu'),
  ('10000000-0000-4000-a000-00000000000b', '00000000-0000-4000-a000-000000000012', 'staff', 'Mamata Das'),
  ('10000000-0000-4000-a000-00000000000b', '00000000-0000-4000-a000-000000000013', 'rider', 'Raju Nayak');

insert into public.kitchen_settings (kitchen_id) values
  ('10000000-0000-4000-a000-00000000000a'), ('10000000-0000-4000-a000-00000000000b');
-- Kitchen A has a (test) Route linked account so payment links work; B has not finished KYC.
insert into public.kitchen_payout_accounts (kitchen_id, razorpay_linked_account_id, kyc_status) values
  ('10000000-0000-4000-a000-00000000000a', 'acc_TestMaaTarini01', 'verified'),
  ('10000000-0000-4000-a000-00000000000b', null, 'pending');

insert into public.member_invites (kitchen_id, phone_e164, role, display_name, invited_by) values
  ('10000000-0000-4000-a000-00000000000a', '+919000000100', 'rider', 'Sanju (new rider)',
   '00000000-0000-4000-a000-000000000001');

-- ---------------------------------------------------------------------------
-- Plans (prices in paise)
-- ---------------------------------------------------------------------------
insert into public.plans (id, kitchen_id, name, slots, diet, days_of_week, price_per_meal_paise, description) values
  ('20000000-0000-4000-a000-0000000000a1', '10000000-0000-4000-a000-00000000000a', 'Veg Lunch',
   '{lunch}', 'veg', '{1,2,3,4,5,6}', 7000, 'Rice, dal, 2 sabzi, roti, salad'),
  ('20000000-0000-4000-a000-0000000000a2', '10000000-0000-4000-a000-00000000000a', 'Veg Lunch + Dinner',
   '{lunch,dinner}', 'veg', '{1,2,3,4,5,6}', 6500, 'Two meals a day, Mon–Sat'),
  ('20000000-0000-4000-a000-0000000000a3', '10000000-0000-4000-a000-00000000000a', 'Non-veg Lunch',
   '{lunch}', 'nonveg', '{1,2,3,4,5,6}', 9000, 'Fish or chicken curry with rice'),
  ('20000000-0000-4000-a000-0000000000b1', '10000000-0000-4000-a000-00000000000b', 'Mess Thali (2 meals)',
   '{lunch,dinner}', 'veg', '{1,2,3,4,5,6,7}', 6000, 'Daily thali, all 7 days'),
  ('20000000-0000-4000-a000-0000000000b2', '10000000-0000-4000-a000-00000000000b', 'Jain Lunch',
   '{lunch}', 'jain', '{1,2,3,4,5,6}', 8000, 'No onion, no garlic, no root vegetables'),
  ('20000000-0000-4000-a000-0000000000b3', '10000000-0000-4000-a000-00000000000b', 'Dinner Only',
   '{dinner}', 'veg', '{1,2,3,4,5,6}', 7000, 'Roti, sabzi, dal');

-- ---------------------------------------------------------------------------
-- Customers, addresses, subscriptions (20 in A, 10 in B)
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  v_customer uuid;
  v_address uuid;
begin
  for r in
    select * from (values
      -- kitchen, n, name, phone, diet, lang, area, landmark, lat, lng, plan, status
      ('a', 1, 'Subhashree Mohanty', '9861000001', 'veg', 'or', 'KIIT Square', 'Near Campus 6 gate', 20.3540, 85.8180, 'a1', 'active'),
      ('a', 2, 'Ankit Das', '9861000002', 'veg', 'en', 'Infocity', 'Behind TCS gate 2', 20.3480, 85.8100, 'a1', 'active'),
      ('a', 3, 'Priyanka Sahoo', '9861000003', 'veg', 'or', 'Patia Chhak', 'Opposite Big Bazaar', 20.3550, 85.8220, 'a1', 'active'),
      ('a', 4, 'Rakesh Nayak', '9861000004', 'veg', 'or', 'Damana', 'Near Damana Square', 20.3330, 85.8150, 'a1', 'active'),
      ('a', 5, 'Smruti Patnaik', '9861000005', 'veg', 'or', 'Chandrasekharpur', 'Sailashree Vihar, lane 3', 20.3260, 85.8180, 'a1', 'active'),
      ('a', 6, 'Debasish Mishra', '9861000006', 'veg', 'hi', 'Patia', 'Near Patia Station', 20.3600, 85.8250, 'a1', 'active'),
      ('a', 7, 'Lipsa Rout', '9861000007', 'veg', 'or', 'KIIT Square', 'Ladies hostel QC-4', 20.3560, 85.8160, 'a1', 'active'),
      ('a', 8, 'Sambit Behera', '9861000008', 'veg', 'en', 'Infocity', 'Infosys back gate', 20.3460, 85.8070, 'a1', 'active'),
      ('a', 9, 'Ipsita Panda', '9861000009', 'veg', 'or', 'Raghunathpur', 'Near Raghunathpur temple', 20.3650, 85.8200, 'a1', 'active'),
      ('a', 10, 'Abinash Jena', '9861000010', 'veg', 'or', 'Patia', 'DLF Cybercity tower B', 20.3500, 85.8060, 'a1', 'active'),
      ('a', 11, 'Sonali Swain', '9861000011', 'veg', 'or', 'Nandankanan Road', 'Opposite Kalinga Hospital', 20.3300, 85.8230, 'a1', 'active'),
      ('a', 12, 'Biswajit Pradhan', '9861000012', 'veg', 'en', 'Patia', 'Near Kanan Vihar phase 2', 20.3580, 85.8300, 'a1', 'active'),
      ('a', 13, 'Pooja Mohapatra', '9861000013', 'veg', 'or', 'Chandrasekharpur', 'Niladri Vihar, near park', 20.3230, 85.8210, 'a2', 'active'),
      ('a', 14, 'Satyajit Barik', '9861000014', 'veg', 'hi', 'Damana', 'Behind Damana post office', 20.3350, 85.8120, 'a2', 'active'),
      ('a', 15, 'Ananya Tripathy', '9861000015', 'veg', 'or', 'KIIT Square', 'KIIT road, Sai mandir lane', 20.3530, 85.8200, 'a2', 'active'),
      ('a', 16, 'Chinmay Dash', '9861000016', 'veg', 'en', 'Infocity', 'Wipro gate, PG house', 20.3470, 85.8090, 'a2', 'active'),
      ('a', 17, 'Riya Senapati', '9861000017', 'veg', 'or', 'Patia', 'Patia Big Bazaar lane', 20.3545, 85.8235, 'a2', 'active'),
      ('a', 18, 'Manas Parida', '9861000018', 'nonveg', 'or', 'Raghunathpur', 'Near Gangapada road', 20.3670, 85.8180, 'a3', 'active'),
      ('a', 19, 'Swati Samal', '9861000019', 'nonveg', 'or', 'Patia', 'Kalinga Vihar, block C', 20.3610, 85.8270, 'a3', 'active'),
      ('a', 20, 'Kunal Biswal', '9861000020', 'veg', 'en', 'KIIT Square', 'Near KIMS hospital', 20.3520, 85.8140, 'a1', 'trial'),
      ('b', 1, 'Gyana Ranjan Sethi', '9862000001', 'veg', 'or', 'Saheed Nagar', 'Near Ram Mandir', 20.2890, 85.8440, 'b1', 'active'),
      ('b', 2, 'Madhusmita Nanda', '9862000002', 'veg', 'or', 'Bapuji Nagar', 'Behind Bapuji Nagar market', 20.2560, 85.8330, 'b1', 'active'),
      ('b', 3, 'Prateek Agarwal', '9862000003', 'jain', 'hi', 'Saheed Nagar', 'Esplanade One road', 20.2950, 85.8480, 'b2', 'active'),
      ('b', 4, 'Bhagyashree Rath', '9862000004', 'veg', 'or', 'Satya Nagar', 'Near Satya Nagar petrol pump', 20.2830, 85.8410, 'b1', 'active'),
      ('b', 5, 'Saroj Kumar Lenka', '9862000005', 'veg', 'or', 'Unit 4', 'MLA colony gate', 20.2810, 85.8300, 'b3', 'active'),
      ('b', 6, 'Neha Jain', '9862000006', 'jain', 'hi', 'Saheed Nagar', 'Jain mandir lane', 20.2910, 85.8460, 'b2', 'active'),
      ('b', 7, 'Tapas Acharya', '9862000007', 'veg', 'or', 'Saheed Nagar', 'Maharishi College road', 20.2930, 85.8420, 'b1', 'active'),
      ('b', 8, 'Itishree Dalai', '9862000008', 'veg', 'or', 'Bapuji Nagar', 'Near BJB college', 20.2600, 85.8350, 'b3', 'active'),
      ('b', 9, 'Rohit Choudhury', '9862000009', 'veg', 'en', 'Saheed Nagar', 'Near Kalyan Mandap', 20.2870, 85.8490, 'b1', 'active'),
      ('b', 10, 'Sasmita Sahu', '9862000010', 'veg', 'or', 'Satya Nagar', 'Opposite AG square', 20.2800, 85.8380, 'b3', 'trial')
    ) as t(k, n, name, phone, diet, lang, area, landmark, lat, lng, plan, status)
  loop
    v_customer := private.insert_customer(
      ('10000000-0000-4000-a000-00000000000' || r.k)::uuid,
      r.name, '+91' || r.phone, r.diet::public.diet_type, r.lang::public.language_code, null,
      jsonb_build_object('line1', 'House ' || r.n, 'area', r.area, 'landmark', r.landmark, 'lat', r.lat, 'lng', r.lng),
      'vendor', 'vendor');
    select id into v_address from public.addresses where customer_id = v_customer and is_default;
    insert into public.subscriptions (kitchen_id, customer_id, plan_id, address_id, start_date, status)
    values (('10000000-0000-4000-a000-00000000000' || r.k)::uuid, v_customer,
      ('20000000-0000-4000-a000-0000000000' || r.plan)::uuid, v_address,
      case when r.status = 'trial' then current_date - 1 else current_date - 10 end, r.status::public.subscription_status);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- A week of meals (M2). Runs the real engine with a simulated clock (app.now):
-- each past day is generated the evening before, a few customers skip, then the
-- day's slots are locked. Ends with today's real-time refresh and lock.
-- ---------------------------------------------------------------------------

-- Opening balances (until recharges exist in M3): 40 meals for every active subscription.
insert into public.balance_entries (kitchen_id, customer_id, type, meals, amount_paise, note, created_at)
select s.kitchen_id, s.customer_id, 'adjust', 40, 40 * p.price_per_meal_paise, 'Opening balance (seed)',
       now() - interval '8 days'
from public.subscriptions s
join public.plans p on p.id = s.plan_id
where s.status = 'active';

do $$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  d date;
  r record;
begin
  for d in select g::date from generate_series(v_today - 7, v_today, interval '1 day') g loop
    perform set_config('app.now', (((d - 1) + time '18:00') at time zone 'Asia/Kolkata')::text, true);
    perform private.refresh_orders(null, null, 2);

    -- Three customers per day skip by WhatsApp before the cutoff (deterministic pick).
    for r in select s.id from public.subscriptions s where s.status = 'active'
             order by md5(s.id::text || d::text) limit 3 loop
      perform private.apply_change(r.id, 'skip', d, d, null, null, 'whatsapp', false, null, false, null);
    end loop;

    if d < v_today then
      perform set_config('app.now', ((d + time '13:00') at time zone 'Asia/Kolkata')::text, true);
      perform private.run_due_locks();
    end if;
  end loop;

  -- Today's 00:30 nightly run (generates the next 7 days before any of their cutoffs).
  perform set_config('app.now', ((v_today + time '00:30') at time zone 'Asia/Kolkata')::text, true);
  perform private.nightly();

  -- Back to the real clock: lock whatever is already past its cutoff.
  perform set_config('app.now', '', true);
  perform private.refresh_orders(null, null, 7);
  perform private.run_due_locks();

  -- Messages queued by the simulated history are not real; keep the outbox clean.
  update public.notifications_outbox set status = 'cancelled', last_error = 'seed history';
end $$;

-- A week of deliveries (M5). Runs were built at each lock; the riders delivered every past run
-- (OTP proof, a few without proof), a couple of customers were not home and one stop was late
-- from the kitchen (credited). Today's runs stay planned so they can be tried in the app.
do $$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_start timestamptz;
  r record;
  s record;
  i integer := 0;
begin
  for r in select * from public.delivery_runs where service_date < v_today order by service_date, slot loop
    v_start := (r.service_date + case when r.slot = 'lunch' then time '12:00' else time '19:30' end) at time zone 'Asia/Kolkata';
    perform set_config('app.now', v_start::text, true);
    perform private.do_start_run(r.id, null, r.rider_id);
    for s in select ds.*, a.lat, a.lng from public.delivery_stops ds left join public.addresses a on a.id = ds.address_id
             where ds.run_id = r.id order by ds.seq loop
      i := i + 1;
      perform set_config('app.now', (v_start + s.seq * interval '4 minutes')::text, true);
      if i % 37 = 0 then
        perform private.do_fail_stop(s.id, 'not_home', null, s.lat, s.lng, null, 0, null, false, r.rider_id);
      elsif i = 50 then
        perform private.do_fail_stop(s.id, 'kitchen_late', 'Lunch left the kitchen 40 minutes late', s.lat, s.lng, null, 0,
                                     null, false, r.rider_id);
      else
        perform private.do_complete_stop(s.id, case when i % 11 = 0 then 'none' else 'otp' end::public.proof_type,
          (select otp from public.delivery_stops where id = s.id), null, s.lat, s.lng, 15, null,
          1, case when i % 5 = 0 then 0 else 1 end, 0, null, i % 17 = 0, r.rider_id);
      end if;
    end loop;
    perform set_config('app.now', (v_start + interval '2 hours')::text, true);
    perform private.do_finish_run(r.id, null, r.rider_id);
  end loop;
  perform set_config('app.now', '', true);
  update public.notifications_outbox set status = 'cancelled', last_error = 'seed history'
  where status = 'pending' and template in ('on_the_way', 'delivery_credit');
end $$;

-- Menus for the next 7 days.
insert into public.menus (kitchen_id, service_date, slot, dishes, published)
select k.id, (now() at time zone 'Asia/Kolkata')::date + g, sl.slot,
       case sl.slot
         when 'lunch' then string_to_array((array[
           'Rice|Dalma|Aloo bhaja|Saga|Salad',
           'Rice|Dal|Besara|Pampada|Khatta',
           'Rice|Dal|Santula|Roti|Curd',
           'Jeera rice|Dal fry|Paneer curry|Roti|Salad',
           'Rice|Dalma|Potala rasa|Bhaja|Pickle',
           'Pakhala|Badi chura|Aloo bharta|Saga bhaja',
           'Rice|Dal|Mixed veg|Roti|Kheer'])[1 + (g % 7)], '|')
         else array['Roti', 'Sabzi', 'Dal', 'Salad']
       end,
       true
from public.kitchens k
cross join generate_series(0, 6) g
cross join unnest(enum_range(null::public.meal_slot)) as sl(slot);

-- ---------------------------------------------------------------------------
-- WhatsApp (M4), local only
-- ---------------------------------------------------------------------------
-- Lets pg_cron (private.kick_outbox) call the whatsapp-outbox function inside the Docker network.
-- The key is the Supabase CLI's public local-development service key, not a real secret.
select vault.create_secret('http://supabase_kong_tiffin:8000/functions/v1', 'functions_base_url');
select vault.create_secret('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU', 'service_role_key');

-- Half of kitchen A's customers have opted in to WhatsApp updates.
update public.customers set whatsapp_opt_in = true
where kitchen_id = '10000000-0000-4000-a000-00000000000a' and phone_last4::int % 2 = 1;
insert into public.consents (kitchen_id, customer_id, purpose, basis, channel)
select kitchen_id, id, 'whatsapp', 'customer', 'whatsapp' from public.customers where whatsapp_opt_in;
