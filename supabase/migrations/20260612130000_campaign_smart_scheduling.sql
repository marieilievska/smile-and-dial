alter table public.campaigns
  add column if not exists smart_scheduling boolean not null default false;
comment on column public.campaigns.smart_scheduling is
  'When true, the retry engine aims each next attempt at the lead''s historically best-answering in-hours window instead of the default 9am-next-day.';
