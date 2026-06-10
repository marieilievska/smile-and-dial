-- Cache for the "best time to call" connect-rate heatmap.
--
-- Computing the 7x24 heatmap scans up to 90 days of historical calls, so we do
-- it ONCE per day in a cron and stash the result in the app_settings singleton.
-- The retry engine then only READS this cache when scheduling a smart-scheduled
-- campaign's next attempt — it never recomputes the heatmap on the hot path.

alter table public.app_settings
  add column if not exists best_time_heatmap jsonb,
  add column if not exists best_time_heatmap_at timestamptz;

comment on column public.app_settings.best_time_heatmap is
  'Cached 7x24 connect-rate heatmap (computed daily) used by smart scheduling.';
