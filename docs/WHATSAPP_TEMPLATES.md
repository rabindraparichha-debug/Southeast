# WhatsApp message templates (submit to Meta)

Meta only lets us message a customer outside the 24-hour customer-service window with **approved templates**. The worker (`supabase/functions/whatsapp-outbox`) picks a template automatically when the window is closed. Inside the window it sends the same content as a normal message.

**Source of truth:** `supabase/functions/_shared/templates.ts`. The names, parameters and wording below must match it exactly. Change both together.

| Status | Languages |
|---|---|
| Ready to submit | English |
| ⏳ Drafts, review by a native speaker before submitting (D-057) | Odia (`or`), Hindi (`hi`) |

**Also confirm in Meta Business Manager:**
- **Language code `or`:** that Odia is offered under that code.
- **Category:** utility templates are cheaper than marketing ones, and Meta may re-categorise a template it considers promotional.

## Customer templates

| Name | Category | Body (English) | Parameters | Quick replies |
|---|---|---|---|---|
| `payment_receipt_v1` | Utility | `{{1}}: payment of {{2}} received for {{3}} meals. Balance: {{4}} meals. Thank you!` | kitchen, amount, meals, balance | – |
| `refund_notice_v1` | Utility | `{{1}}: a refund of {{2}} for {{3}} unused meals has been created. You will be told when it is paid.` | kitchen, amount, meals | – |
| `refund_receipt_v1` | Utility | `{{1}}: your refund of {{2}} has been paid ({{3}}).` | kitchen, amount, method | – |
| `low_balance_v1` | Utility | `{{1}}: you have {{2}} meals left. Reply PAY to recharge.` | kitchen, meals | – |
| `dues_reminder_v1` | Utility | `{{1}}: {{2}} is due for {{3}} meals. Reply PAY to pay now.` | kitchen, amount, meals | – |
| `tomorrow_menu_v1` | Utility | `{{1}}: tomorrow's menu ({{2}}): {{3}}. Not eating? Tap Skip before the cutoff.` | kitchen, date, dishes | `Skip tomorrow` (payload `nudge_skip\|<date>`), `Keep` (`nudge_keep`) |
| `kitchen_message_v1` | Utility | `Message from {{1}}: {{2}}` | kitchen, text | – |
| `kitchen_update_v1` | Marketing | `Update from {{1}}: {{2}}` | kitchen, text | – |
| `on_the_way_v1` | Utility | `{{1}}: your {{2}} is on the way with {{3}} (stop {{4}} of {{5}}). Delivery code: {{6}}. Share it only when you receive your tiffin.` | kitchen, lunch/dinner, rider first name, stop, stops, 4-digit code | – |
| `trial_followup_v1` | Utility | `{{1}}: hope you are enjoying your trial meals! Continue with {{2}}: {{3}} meals for {{4}}. Pay here: {{5}}` | kitchen, plan, meals, amount, link | – |
| `delivery_credit_v1` | Utility | `{{1}}: sorry, your {{2}} on {{3}} could not be delivered. {{4}} meal(s) have been added back to your balance.` | kitchen, lunch/dinner, date, meals | – |

## Platform templates (people who are not a kitchen's customer yet)

Sent from the platform number with no kitchen name. Leads and vendor applicants get them only if they opted in.

| Name | Category | Body (English) | Parameters | Quick replies |
|---|---|---|---|---|
| `lead_welcome_v1` | Utility | `Namaskar {{1}}! Thanks for your tiffin enquiry. Tap below and we will show you home kitchens near you with space.` | first name | `Find my tiffin` (`lead_start`) |
| `lead_reminder_v1` | Utility | `Namaskar! The kitchens we found near you still have space: {{1}}. Tap below to see them again.` | kitchen names | `Show kitchens` (`l_show`) |
| `vendor_welcome_v1` | Utility | `Namaskar {{1}}! Thank you for joining Tiffin OS. It is free. Log in with this number to set up your kitchen: {{2}}` | first name, link | – |
| `vendor_nudge_v1` | Utility | `Namaskar {{1}}! Your next step on Tiffin OS: {{2}}. Open: {{3}}` | first name, next step, link | – |

## Kitchen-owner templates (English)

| Name | Category | Body | Parameters |
|---|---|---|---|
| `owner_summary_v1` | Utility | `{{1}} for {{2}}: lunch {{3}} meals, dinner {{4}} meals (preview until cutoff). Collections today: {{5}}. Low stock: {{6}}.` | kitchen, date, lunch, dinner, collections, low-stock items |
| `stock_alert_v1` | Utility | `{{1}} stock alert: {{2}}. Details are in the app.` | kitchen, alert ("Toor dal is low: 4 kg left (minimum 5 kg)", "Toor dal price up 25% (₹120 → ₹150 per kg)", "stock-take found Toor dal short by 1 kg (Spilled)") |
| `production_sheet_v1` | Utility | `{{1}} final count for {{2}} {{3}}: {{4}} meals (veg {{5}}, non-veg {{6}}, Jain {{7}}). Packing list is in the app.` | kitchen, date, slot, total, veg, non-veg, Jain |
| `new_platform_customer_v1` | Utility | `{{1}}: new customer from Tiffin platform: {{2}} ({{3}}), {{4}}, trial of {{5}} meals. They are in Customers in the app.` | kitchen, customer, area, plan, trial meals |
| `inbox_alert_v1` | Utility | `{{1}}: {{2}} needs a reply in your inbox ({{3}}).` | kitchen, customer, reason |

## Still to add (later milestones)

| Name | Category | Purpose |
|---|---|---|
| `otp_v1` | Authentication | Login codes, if WhatsApp OTP is chosen (D-004) |

## Opt-in rules the code enforces

- **Templates go only to customers who opted in** (`customers.whatsapp_opt_in`). The bot asks once, on the customer's first message. Vendors can also share an invite link that opens a chat with the platform number.
- **Replies inside the 24-hour window are normal messages.** They need no opt-in, because the customer wrote first.
- **Announcements:** only to opted-in customers, and limited per kitchen per month (`kitchen_settings.broadcast_cap_monthly`, default 4, set by the platform).
