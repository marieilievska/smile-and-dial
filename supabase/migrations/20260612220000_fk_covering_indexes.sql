-- Covering indexes for foreign keys (Supabase performance advisor: 19 unindexed
-- FKs). Without an index on the referencing column, every join/filter on that
-- FK — and every cascading delete/update of the parent — does a sequential scan.
-- At 14.5k+ leads (and growing calls/callbacks/emails), that's a real drag on
-- the data-heavy pages (Leads, Calls, Callbacks) and adds avoidable DB load.
--
-- All additive and idempotent. CREATE INDEX briefly locks writes on the table,
-- but at current row counts each finishes in well under a second.

-- calls (hot: joined on every Calls-page read)
create index if not exists idx_calls_agent_id on public.calls (agent_id);
create index if not exists idx_calls_placed_by on public.calls (placed_by);
create index if not exists idx_calls_twilio_number_id on public.calls (twilio_number_id);

-- callbacks (joined to calls for "last callback notes" + the callbacks page)
create index if not exists idx_callbacks_created_by on public.callbacks (created_by);
create index if not exists idx_callbacks_originating_call_id on public.callbacks (originating_call_id);
create index if not exists idx_callbacks_result_call_id on public.callbacks (result_call_id);

-- campaigns
create index if not exists idx_campaigns_agent_id on public.campaigns (agent_id);
create index if not exists idx_campaigns_goal_id on public.campaigns (goal_id);
create index if not exists idx_campaigns_twilio_number_id on public.campaigns (twilio_number_id);

-- dnc
create index if not exists idx_dnc_entries_added_by_user_id on public.dnc_entries (added_by_user_id);
create index if not exists idx_dnc_entries_source_call_id on public.dnc_entries (source_call_id);
create index if not exists idx_dnc_removals_removed_by_user_id on public.dnc_removals (removed_by_user_id);

-- emails
create index if not exists idx_emails_call_id on public.emails (call_id);
create index if not exists idx_emails_campaign_id on public.emails (campaign_id);
create index if not exists idx_emails_template_id on public.emails (template_id);

-- lead custom values (joined on the lead detail page)
create index if not exists idx_lead_custom_values_custom_field_id on public.lead_custom_values (custom_field_id);

-- misc
create index if not exists idx_api_idempotency_keys_lead_id on public.api_idempotency_keys (lead_id);
create index if not exists idx_profiles_active_campaign_id on public.profiles (active_campaign_id);
create index if not exists idx_twilio_numbers_attached_campaign_id on public.twilio_numbers (attached_campaign_id);
