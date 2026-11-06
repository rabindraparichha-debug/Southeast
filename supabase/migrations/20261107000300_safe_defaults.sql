-- Vendor-first wave 1, item 7: safe defaults for Phase 1 (vendor automation only).
--
-- * kitchens.accepts_platform_leads: a kitchen marked active was open to marketplace leads by
--   default. Phase 1 has no marketplace, so kitchens now opt in (Settings → Listing).
-- * kitchen_settings.auto_credit_first_complaint: the first complaint gave a free meal by default
--   (D-099). It is the kitchen's cost, so kitchens now opt in (Settings → Customer care).
--
-- Existing rows are switched off too: nobody chose the old values, they were defaults, and the
-- marketplace and the customer complaint channels are not live yet (see DECISIONS.md D-119).
alter table public.kitchens alter column accepts_platform_leads set default false;
update public.kitchens set accepts_platform_leads = false where accepts_platform_leads;

alter table public.kitchen_settings alter column auto_credit_first_complaint set default false;
update public.kitchen_settings set auto_credit_first_complaint = false where auto_credit_first_complaint;
