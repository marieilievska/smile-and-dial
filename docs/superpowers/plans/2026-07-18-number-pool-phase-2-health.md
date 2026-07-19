# Number Pool — Phase 2 (health + auto-rest) Implementation Plan

**Goal:** Turn the pool into a self-protecting system: continuously score each number's connect rate, temporarily **rest** any number whose rate craters (auto-returns after a cool-off), and **flag** a genuinely-burned number for operator review — so high-volume dialing can't quietly destroy the pool's reputation.

**Key finding driving the approach:** the repo already has a **dormant** SQL function `monitor_twilio_connect_rates()` (`20260525260000_create_connect_rate_monitor.sql`) that computes a per-number connect rate and writes `last_connect_rate_24h` / `last_calls_count_24h` / `last_connect_rate_check_at`, and flags bad numbers + notifies admins — but its cron (`20260525270000`) was **intentionally commented out**, so it never ran (which is why those fields were empty). Phase 2 **extends that function** with the pool's temporary-rest model and **activates its cron**. Pure SQL; no new endpoint, no TS.

**Architecture:** Two additive migrations. The monitor becomes the health engine `selectPoolNumber` (Phase 1) already reads from: it writes `rested_until` (temporary, auto-returns) and `flagged_for_rotation` (held for operator review), both of which Phase 1 selection already excludes. Thresholds live in `app_settings.number_pool_settings`.

**Deferred (noted, not gaps):** Tier B same-state fallback + the NANP area-code→state map (a small follow-up — a correct ~350-entry map should be sourced carefully; exact-area-code + least-used already ship). Pool-median-relative rest thresholds (v1 uses an absolute floor; median-relative is a later refinement). Repeat-offender event-history escalation (v1 uses a "very low rate" tier instead, no history needed).

---

## Task 1: Rewrite the monitor into the health + auto-rest engine

**Files:**

- Create: `supabase/migrations/20260718160000_number_pool_health_monitor.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Number pool Phase 2: make the (previously dormant) connect-rate monitor the
-- pool's health + auto-rest engine.
--
-- Re-declares monitor_twilio_connect_rates() to: measure over a trailing 24h
-- window (not the UTC calendar day); keep refreshing last_connect_rate_24h /
-- last_calls_count_24h / last_connect_rate_check_at on every non-released number
-- every run; and ACT on a cratering ACTIVE number — a very low rate FLAGS it for
-- operator review (flagged_for_rotation + admin notification), a merely-low rate
-- RESTS it temporarily (rested_until = now + rest_hours). selectPoolNumber
-- (Phase 1) skips rested/flagged numbers; rested ones auto-return when
-- rested_until passes. We NEVER auto-retire. Thresholds come from
-- app_settings.number_pool_settings (safe fallbacks if absent).

-- Make the rest thresholds tunable alongside the existing pool settings.
update public.app_settings
   set number_pool_settings = number_pool_settings
     || '{"rest_min_samples":20,"rest_abs_floor":0.10,"rest_hours":24}'::jsonb;

alter table public.app_settings
  alter column number_pool_settings set default
  '{"daily_cap":100,"warmup_days":14,"warmup_start_cap":20,"rest_min_samples":20,"rest_abs_floor":0.10,"rest_hours":24}'::jsonb;

create or replace function public.monitor_twilio_connect_rates()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_acted integer := 0;
  v_number record;
  v_total integer;
  v_connected integer;
  v_rate numeric;
  v_settings jsonb;
  v_min_samples int;
  v_abs_floor numeric;
  v_rest_hours int;
begin
  select number_pool_settings into v_settings from public.app_settings limit 1;
  v_min_samples := coalesce((v_settings->>'rest_min_samples')::int, 20);
  v_abs_floor   := coalesce((v_settings->>'rest_abs_floor')::numeric, 0.10);
  v_rest_hours  := coalesce((v_settings->>'rest_hours')::int, 24);

  for v_number in
    select id, phone_number, flagged_for_rotation, pool_status, rested_until
      from public.twilio_numbers
     where released_at is null
  loop
    -- Trailing-24h outbound calls through this number.
    select count(*) into v_total
      from public.calls
     where twilio_number_id = v_number.id
       and direction = 'outbound'
       and created_at >= now() - interval '24 hours';

    if v_total = 0 then
      update public.twilio_numbers
         set last_connect_rate_check_at = now(),
             last_calls_count_24h = 0,
             last_connect_rate_24h = null
       where id = v_number.id;
      continue;
    end if;

    -- "Connected" = anything except the hard non-connection outcomes (matches the
    -- monitor's original definition — a human/gatekeeper picked up).
    select count(*) into v_connected
      from public.calls
     where twilio_number_id = v_number.id
       and direction = 'outbound'
       and created_at >= now() - interval '24 hours'
       and outcome is not null
       and outcome not in ('voicemail', 'no_answer', 'busy', 'failed', 'invalid_number');

    v_rate := v_connected::numeric / v_total::numeric;

    update public.twilio_numbers
       set last_connect_rate_check_at = now(),
           last_calls_count_24h = v_total,
           last_connect_rate_24h = v_rate
     where id = v_number.id;

    -- Act only on ACTIVE numbers with a trustworthy sample.
    if v_number.pool_status = 'active' and v_total >= v_min_samples then
      if v_rate < v_abs_floor / 2.0 and not v_number.flagged_for_rotation then
        -- Very low rate = likely burned. Flag for operator review (held out but
        -- still reusable) + notify admins. Never auto-retire.
        update public.twilio_numbers
           set flagged_for_rotation = true
         where id = v_number.id;

        insert into public.notifications (user_id, kind, message, ref_table, ref_id)
        select p.id,
               'twilio_number_flagged',
               format(
                 'Number %s flagged: %s%% connect rate over %s calls (24h) — review or replace.',
                 v_number.phone_number, round(v_rate * 100, 1), v_total
               ),
               'twilio_numbers', v_number.id
          from public.profiles p
         where p.role = 'admin';

        v_acted := v_acted + 1;

      elsif v_rate < v_abs_floor
            and (v_number.rested_until is null or v_number.rested_until <= now()) then
        -- Bad day: temporary rest; auto-returns when rested_until passes.
        update public.twilio_numbers
           set rested_until = now() + make_interval(hours => v_rest_hours)
         where id = v_number.id;

        insert into public.system_events (kind, actor_user_id, ref_table, ref_id, payload)
        values ('number_rested', null, 'twilio_numbers', v_number.id,
                jsonb_build_object(
                  'phone_number', v_number.phone_number,
                  'connect_rate', v_rate,
                  'calls_24h', v_total,
                  'rested_hours', v_rest_hours
                ));
        v_acted := v_acted + 1;
      end if;
    end if;
  end loop;

  return v_acted;
end;
$$;

comment on function public.monitor_twilio_connect_rates is
  'Pool health + auto-rest engine (Phase 2). Every run refreshes '
  'last_connect_rate_24h / last_calls_count_24h / last_connect_rate_check_at on '
  'each non-released number over a trailing 24h window. For an ACTIVE number with '
  '>= rest_min_samples calls: rate < rest_abs_floor/2 flags it for operator '
  'review (+admin notification); rate < rest_abs_floor rests it temporarily '
  '(rested_until = now + rest_hours). selectPoolNumber skips rested/flagged '
  'numbers; rested ones auto-return. Never auto-retires. Returns count acted on.';
```

- [ ] **Step 2: Apply to prod (operator go-ahead required)**

Run: `supabase db push --linked`. Additive: redefines the function + merges 3 keys
into the settings jsonb. No table/column drops.

- [ ] **Step 3: Verify (safe — no side effects when idle)**

Invoke it once and confirm it runs clean and refreshes the fields. Because it's a
weekend / no calls in the last 24h, every number has `v_total = 0` → sets
`last_calls_count_24h = 0`, `last_connect_rate_24h = null`, and **rests/flags
nothing** (returns 0):

```sql
select public.monitor_twilio_connect_rates();               -- expect 0
select phone_number, last_calls_count_24h, last_connect_rate_24h,
       last_connect_rate_check_at, rested_until, flagged_for_rotation
  from public.twilio_numbers where released_at is null;      -- check_at just updated
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260718160000_number_pool_health_monitor.sql
git commit -m "feat(pool): connect-rate monitor becomes health + auto-rest engine"
```

---

## Task 2: Activate the health cron

**Files:**

- Create: `supabase/migrations/20260718160100_number_pool_health_cron.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Activate the pool health monitor (was intentionally dormant). Runs every 30
-- minutes so a cratering number is rested within half an hour. The function is
-- pure SQL, so the cron calls it directly (no HTTP). cron.schedule upserts by
-- jobname, so re-applying is safe.
create extension if not exists pg_cron;

select cron.schedule(
  'twilio-connect-rate-monitor',
  '*/30 * * * *',
  $$ select public.monitor_twilio_connect_rates(); $$
);
```

- [ ] **Step 2: Apply**

Run: `supabase db push --linked`.

- [ ] **Step 3: Verify the job is scheduled**

```sql
select jobname, schedule, active from cron.job
 where jobname = 'twilio-connect-rate-monitor';   -- one row, active = true
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260718160100_number_pool_health_cron.sql
git commit -m "feat(pool): schedule the health monitor every 30 minutes"
```

---

## Self-review

**Spec coverage (Phase-2 slice):** §8 health refresh + auto-rest + burn escalation → Task 1 (extends the existing monitor; rest = temporary/auto-return per the operator's rest/reuse decision; flag = operator review, never auto-retire). Cron cadence (~30 min) → Task 2. `pool_exhausted` events already emitted by Phase 1's dialer; `number_rested` added here.

**Reuse over rebuild:** extends the existing `monitor_twilio_connect_rates` + `flagged_for_rotation` + notification machinery rather than adding a parallel TS endpoint — one health path, not two.

**Integration with Phase 1:** `selectPoolNumber` already filters `rested_until`/`flagged_for_rotation`/`pool_status`, so a rested or flagged number leaves rotation immediately and a rested one auto-returns — no code change needed.

**Deferred (explicit):** Tier B same-state + NANP map; median-relative thresholds; event-history repeat escalation. All noted above; none block the reputation-protection value this phase delivers.

**Prod-safety:** both migrations additive (redefine a function, merge settings keys, schedule a cron); verified to be a no-op on an idle weekend (no false rests). Threshold defaults are conservative (rest only at <10% connect over ≥20 calls).
