-- Phase 2 of removing leads.ai_summary. Call context now comes solely from the
-- per-campaign lead_campaign_summaries table; the code that read/wrote this
-- column was removed and deployed first (phase 1), so dropping it is safe.
alter table public.leads drop column if exists ai_summary;
