-- Call Reviewer engine tables. review_flag_defs = the data-driven rubric;
-- call_reviews = per-call work queue + result; call_review_flags = confirmed/
-- needs-review flags with evidence. Buckets (Phase 2) are a live query over
-- call_review_flags, not a table.

create table if not exists public.review_flag_defs (
  id uuid primary key default gen_random_uuid(),
  key text unique not null,
  label text not null,
  lens text not null check (lens in ('bug','compliance','quality','opportunity','voc')),
  severity int not null default 3,          -- 1 high … 4 info
  guidance text not null,                    -- analyzer prompt text for this flag
  active boolean not null default true,
  is_candidate boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.call_reviews (
  call_id uuid primary key references public.calls(id) on delete cascade,
  status text not null default 'pending',    -- pending | analyzing | done | error
  reached_human boolean not null default false,
  needs_review boolean not null default false,
  pass1_model text,
  pass2_model text,
  cost numeric not null default 0,
  error text,
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  analyzed_at timestamptz
);
create index if not exists call_reviews_status_idx on public.call_reviews (status);

create table if not exists public.call_review_flags (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.calls(id) on delete cascade,
  flag_key text not null references public.review_flag_defs(key),
  evidence_quote text,
  confidence numeric,
  status text not null default 'confirmed', -- confirmed | needs_review | rejected
  created_at timestamptz not null default now(),
  unique (call_id, flag_key)
);
create index if not exists call_review_flags_bucket_idx
  on public.call_review_flags (flag_key, status);
create index if not exists call_review_flags_call_idx
  on public.call_review_flags (call_id);

alter table public.review_flag_defs enable row level security;
alter table public.call_reviews enable row level security;
alter table public.call_review_flags enable row level security;

-- Admin-only read; writes go through service-role workers/actions (matching
-- hot_lead_dismissals / the reporting tables).
create policy "admins read review_flag_defs" on public.review_flag_defs
  for select using (public.is_admin((select auth.uid())));
create policy "admins read call_reviews" on public.call_reviews
  for select using (public.is_admin((select auth.uid())));
create policy "admins read call_review_flags" on public.call_review_flags
  for select using (public.is_admin((select auth.uid())));

-- Seed the starter rubric (spec §"The flag rubric").
insert into public.review_flag_defs (key, label, lens, severity, guidance, sort_order) values
  ('booking_failed_then_recovered','Booking failed then recovered','bug',1,'The booking tool errored or the agent said a time was unavailable, then the SAME appointment/slot was booked anyway — a confusing failure the customer heard.',1),
  ('tool_error','Tool error mid-call','bug',1,'A server tool (booking, email, callback, transfer) failed or returned an error during the call.',2),
  ('wrong_data_used','Wrong lead data used','bug',1,'The agent used a stale or wrong name/company/detail for this business (e.g. called them by a different company name).',3),
  ('dead_air','Dead air / long silence','bug',2,'Noticeable silence or latency where the agent should have responded.',4),
  ('dropped_midconversation','Dropped mid-conversation','bug',2,'The call ended abruptly in the middle of a real conversation.',5),
  ('agent_looped','Agent looped / stuck','bug',2,'The agent repeated itself or got stuck in a loop.',6),
  ('transfer_failed','Transfer failed','bug',2,'A transfer to a human was attempted but did not connect.',7),
  ('dnc_not_honored','DNC not honored','compliance',1,'The person asked not to be called / to stop, and the agent kept pitching instead of ending.',10),
  ('misleading_claim','Misleading claim','compliance',1,'The agent stated something untrue or misleading about the offer, price, or company.',11),
  ('overpromised','Overpromised','compliance',1,'The agent promised something we may not be able to deliver.',12),
  ('wrong_info_given','Wrong info given','quality',2,'The agent gave factually incorrect information about the product/offer (not necessarily misleading on purpose).',20),
  ('fumbled_objection','Fumbled an objection','quality',2,'The customer raised a question/objection and the agent ignored it, argued, or answered poorly.',21),
  ('rambled_unclear','Rambled / unclear','quality',3,'The agent was long-winded, confusing, or off-message.',22),
  ('pushy_or_rude','Pushy or rude','quality',2,'The agent was aggressive, interrupted, or disrespectful.',23),
  ('off_goal','Never advanced the goal','quality',3,'The agent never moved toward the campaign goal (e.g. never offered to book / never asked the research questions).',24),
  ('didnt_confirm_details','Did not confirm details','quality',3,'The agent captured an email/time/booking but never read it back to confirm.',25),
  ('awkward_delivery','Awkward delivery','quality',3,'Robotic delivery or mispronounced the business/brand/contact name.',26),
  ('hot_lead_not_booked','Hot lead not booked','opportunity',2,'The customer showed clear interest but no booking or concrete next step was secured.',30),
  ('decision_maker_no_ask','Reached DM, no ask','opportunity',2,'The agent reached the owner/decision maker but did not push for the goal.',31),
  ('callback_promised_not_scheduled','Callback promised, not scheduled','opportunity',2,'The customer agreed to talk later but no callback time was captured.',32),
  ('goal_met_needs_followup','Won, needs follow-up','opportunity',3,'The goal was met but the call suggests a human follow-up would help.',33),
  ('price_objection','Price objection','voc',4,'The customer pushed back on cost/price.',40),
  ('not_interested_reason','Not interested (reason)','voc',4,'The customer declined — capture WHY in the evidence quote.',41),
  ('competitor_mentioned','Competitor mentioned','voc',4,'The customer named a competitor or their current provider.',42),
  ('software_mentioned','Software mentioned','voc',4,'The customer named their CRM/booking/business software.',43),
  ('feature_or_need_request','Feature/need request','voc',4,'The customer asked for something specific or expressed a need.',44),
  ('strong_interest','Strong interest','voc',4,'The customer was clearly enthusiastic / strongly interested.',45),
  ('confused_by_offer','Confused by the offer','voc',4,'The customer did not understand the offer or pitch.',46),
  -- Auto-applied to non-conversations by enqueue (Task 5) — MUST exist because
  -- call_review_flags.flag_key references review_flag_defs(key).
  ('no_conversation','No conversation','voc',4,'Voicemail, no-answer, or instant hang-up — no real conversation happened.',50)
on conflict (key) do nothing;
