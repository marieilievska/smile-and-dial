# Outcome Playbook

Per-outcome audit recipes. For each: what it *should* mean, the **objective signal** to judge by, known traps, and the typical mislabels + where they really belong. Classification source of truth is `src/lib/calls/classify-outcome.ts`; outcome sets are `src/lib/calls/outcomes.ts`; lead-state effects are `src/lib/dialer/retry-engine.ts`.

Outcome is the AI's disposition guess unless `outcome_source='manual'` (a human/earlier audit set it). Always check `outcome_source` — don't re-litigate manual rows.

---

## goal_met — the highest-stakes outcome
Terminal (`status=goal_met`, stops calling) and the headline success number. **The bar is per-campaign.** The two active campaigns share goal "Webinar invite" → success = the decision-maker actually **booked** for the Zoom event.

**Objective signal:** `leads.calendly_event_uri` is set AND a `smiledial_book_appointment` tool call fired on the call. Email captured / "I'll send info" is NOT a booking.

**Three failure modes (all seen 2026-08-10):**
1. **False win** — a gatekeeper handed over the owner's email, the AI fired `send_email`, and the disposition extractor marked `goal_met`. No owner, no booking. → relabel `gatekeeper`, un-terminate.
2. **Real booking mislabeled** — a genuine Calendly booking whose call was labeled `gatekeeper`/other (so it never counted). → relabel `goal_met`, terminate the lead.
3. **Phantom booking** — the AI called `book_appointment` even though the person only asked for info to forward (no real "yes"). A junk Calendly registrant; the `gatekeeper` label is *correct*. Flag it; do NOT relabel to goal_met. Do NOT cancel the Calendly entry.

**Always run `reconcile-bookings.js`** — it lists every lead called that day that has a Calendly booking and whether it's `goal_met`, catching modes 1 and 2 at once. Then read the mode-2/3 transcripts to tell a real booking from a phantom (did the DM actually agree to attend?).

---

## dnc — a person asked to stop
Terminal + compliance-loaded. Valid ONLY when **the person themself asks to be removed / stop calling, unprompted**. NOT when the agent *offers* ("want me to take you off the list?") and they say "sure".

**Objective signal:** in the transcript, who first raised removal? A lead imperative ("take me off", "stop calling", "remove us") = valid. Assent to an agent offer = invalid.

**Traps:**
- ~half of a day's dnc can be agent-manufactured (the agent freelances the offer). Read every one.
- A person saying "you sound like AI, stop calling" is still a valid dnc (human asking to stop), not `ai_receptionist`.

**Fix caution:** un-DNC-ing is reversing a compliance flag. Before setting a formerly-dnc lead callable, confirm it has **no other DNC signal** — no `dnc` call on another day and no `dnc_entries` row (match by `phone` E.164 OR `source_call_id` in the lead's calls). To reverse: relabel the call, DELETE the `dnc_entries` row, set the lead to the real outcome's state.

---

## ai_error — an ElevenLabs billing/quota failure (NOT a call-quality label)
Assigned only when EL kills the call with `termination_reason` matching quota/credit/rate-limit ("This request exceeds your quota limit."). It means **our workspace ran out of credits**, often mid-call on a live human.

**Objective signal:** the EL `termination_reason` — NOT the transcript (blind transcript reads of ai_error are useless; discount 100% "disagreement"). Fetch it: `GET https://api.elevenlabs.io/v1/convai/conversations/{elevenlabs_conversation_id}` → `metadata.termination_reason`.

**This is an incident detector, not a relabel target.** A spike = the account is dry. Run `credit-check.js` first thing. Balance at `GET /v1/user/subscription` (`character_count`/`character_limit`). Nothing in the app alerts on it.

**After a spike:** `ai_error` no longer advances the retry cycle (PR #386 gives it a ~2h reschedule), but check whether older failures pushed leads out and pull them back (`next_call_at`→now for leads whose latest call that day was a quota `ai_error`).

---

## voicemail — a machine answered, no human
~99.7% correct historically. Left as-is: IVR phone-trees and hold queues (they're "no live human", which is what retry logic needs — Marija's call).

**Judge by:** machine greeting / EL `voicemail_detection`. Relabel only the clear misses:
- **AI receptionist** self-ID ("I'm the virtual receptionist") → `ai_receptionist`.
- **Human reached, THEN a mailbox** (front desk talked, offered transfer, tail hit an extension VM) → `gatekeeper` (a late VM must not erase a human).
- **Dead air** (agent talked, other side silent, EL ended on silence) → `no_answer`.
- Automated **call-screener** that takes a message → `voicemail` (stays).

Beware silent auto-receptionists that DON'T announce themselves ("Sky", "Lux") — they stay `gatekeeper` by the literal "says it's an AI" rule.

---

## gatekeeper / gatekeeper_not_interested / not_interested — who declined, how firmly
- `gatekeeper` — reached a non-owner who couldn't connect you and didn't firmly refuse (owner unavailable, took a message, "not now" brush-off with no time). Retries.
- `gatekeeper_not_interested` — a non-owner who **firmly** declined on the business's behalf ("we're not interested", "take us off"). Rests 15d. NOT in `OUTCOME_IMPLIES_DM` (won't falsely imply DM-reached).
- `not_interested` — the **owner/decision-maker themself** declined. Rests 30d. ⚠️ auto-stamps `decision_maker_reached=true` via `OUTCOME_IMPLIES_DM` — so non-owner declines mislabeled `not_interested` inflate the DM metric. Bias: role-unstated solo answerer declining → `gatekeeper_not_interested`, not `not_interested`.

`gatekeeper` is also where a plain "call me later" with no time belongs (the retired `call_back_later` folded here).

---

## callback — a real time/window to reconnect
Valid when a specific time OR timeframe was given (even a receptionist saying when the owner's in). Not valid for "they'll call us back" or no time. Priority-dialed at the callback time.

**Fix mechanics:** relabeling *to* callback needs a `callbacks` row (`lead_id`, `campaign_id`, `originating_call_id`, `scheduled_at`, `status='pending'`) AND lead `status='callback'`, `next_call_at=scheduled_at` — a bare status flip with no row strands the lead. See `fix-patterns.md`.

---

## hung_up_immediately / hung_up_later / no_answer — the fuzzy short-call trio
Independent judges disagree ~43–60% here, almost all churn *between these three* (quick-hangup vs dead-air vs "a receptionist answered briefly"). They are **behaviour-neutral** — all three just retry.

**Do NOT bulk-relabel.** Verifying them by transcript is diminishing returns and only moves labels around. Split rule (`hangUpKind`): `hung_up_immediately` = 0 genuine replies AND ≤15s; else `hung_up_later`. Only fix a clear cross-category error (e.g. a real human conversation mislabeled a hang-up).
