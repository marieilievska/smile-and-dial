-- Corrective re-seed of the Call Reviewer rubric.
--
-- The original starter rubric from 20260705130000 never actually landed in
-- prod (the migration was recorded as applied before its seed rows existed), so
-- prod's review_flag_defs held only discovery-generated flags and was MISSING
-- the `no_conversation` catch-all. Effects: non-human calls silently FK-failed
-- their `no_conversation` flag insert (empty "No conversation" bucket), and the
-- handful of narrow discovered flags almost never matched real calls — so the
-- Call Review tab showed "Nothing to review yet" despite the engine analyzing
-- every call. This restores the full starter rubric. Idempotent: on conflict on
-- the unique `key`, existing rows (incl. approved discovery flags) are untouched.

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
  ('no_conversation','No conversation','voc',4,'Voicemail, no-answer, or instant hang-up — no real conversation happened.',50)
on conflict (key) do nothing;
