-- Vendor-first wave 1, item 15: a 'revoke' change undoes one specific skip or pause.
-- Its own migration: a new enum value cannot be used in the transaction that adds it.
alter type public.change_type add value if not exists 'revoke';
