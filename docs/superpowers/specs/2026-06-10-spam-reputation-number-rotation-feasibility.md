# Caller-ID Spam Reputation & Number Rotation — Feasibility

**Status:** Feasibility / planning (NOT a build spec). Decide phases before building.
**Date:** 2026-06-10

## The problem

US carriers (T-Mobile, AT&T, Verizon) and call-screening apps run analytics engines
that label outbound numbers "Spam Likely" / "Scam Likely" when they see
high-volume, low-answer, short-duration calling patterns. Once labeled, answer
rates collapse. For an outbound AI dialer this is the single biggest threat to
connect rate. Smile & Dial currently dials every campaign from **one** Twilio
number with no reputation awareness.

## The key strategic insight (this changes the plan)

"Number rotation" is widely assumed to be the fix. The research says it's a
**double-edged tactic**: carriers actively detect "snowshoeing" (spreading
volume across many fresh numbers), and that pattern _itself_ triggers spam
flags. The durable fix is **registration + good calling behavior**, with a
_small, consistent_ number pool — not aggressive rotation.

So: **rotation is a tactic; registration is the cure; behavior is the
foundation.** A good plan does all three in proportion.

---

## What's POSSIBLE

### A. Things we fully control (build ourselves, no vendor)

1. **Per-number answer-rate health** — we already store every call with
   `twilio_number_id`, outcome, and duration. We can compute each number's
   rolling answer rate / volume / short-call ratio for free and trend it.
2. **Per-number daily volume caps** — enforce a safe ceiling (industry guidance:
   ~50–100 dials/number/day). We already have campaign caps; this adds a
   per-number cap in the dial path.
3. **Number pool per campaign + smart selection** — buy several Twilio numbers
   (Twilio's API lets us search/buy/release numbers programmatically), store a
   pool, and at dial time pick the healthiest least-recently-used number.
4. **Local presence** — pick the pool number whose **area code matches the
   lead's** (we already derive the lead's area code/timezone). Local caller ID
   measurably lifts answer rates.
5. **Auto-pull + alert** — when a number's answer rate craters, drop it from
   rotation and raise a System Health alert.

### B. Things that need a paid API (low/medium effort to integrate)

6. **Spam-score detection** — **Twilio Lookup + the Nomorobo Spam Score add-on**
   returns a per-number spam score on demand (pay-per-lookup). We can poll our
   own numbers on a schedule and react when one trends bad. (Twilio Lookup is
   already wired into this app for line-type at import — same API.)
7. **Reputation monitoring across carriers** — dedicated vendors **Numeracle**
   or **First Orion (AFFIRM)** show how each number is labeled across T-Mobile /
   AT&T / Verizon ("a credit score for your phone lines") and auto-submit
   remediation. More comprehensive than Nomorobo, higher cost, vendor contract.

### C. The actual cure — registration (mostly setup, little code)

8. **Twilio Voice Integrity (Trust Hub)** — public beta. You register your
   Twilio numbers (via Trust Hub) with the carrier analytics engines to
   _prevent_ and _remediate_ spam labels. This is the legitimate "don't get
   flagged in the first place" path. Requires a verified business identity
   (Trust Hub / brand registration) — a one-time onboarding, not ongoing code.
9. **SHAKEN/STIR attestation** — for numbers you own and originate on Twilio,
   Twilio already applies A-level attestation automatically. Nothing to build;
   just keep numbers properly provisioned on Twilio.
10. **Branded Calling** (show business name/logo on the call) — Twilio lists it
    as "coming soon," needs verification. Future, not now.

---

## What's NOT possible (or has hard caveats)

- **You cannot read, for free and in real time, the exact label a given
  subscriber's phone shows.** The best you get is an _approximation/monitoring_
  signal from a paid service (Nomorobo score, Numeracle, First Orion). Plan
  around signals + your own answer-rate data, not ground truth.
- **Aggressive rotation backfires.** A big pool of churned numbers reads as
  snowshoeing and gets the whole pool flagged faster. Keep the pool small and
  consistent.
- **Registration requires a real verified business identity** (legal entity,
  Trust Hub onboarding). It's paperwork + time, not a code sprint.
- **No instant fix once labeled** — remediation (via Voice Integrity / Numeracle)
  takes time to propagate across carriers; prevention beats cure.

---

## Recommended phasing (build in this order; each is independently valuable)

| Phase                           | What                                                                                                                                                                  | Build effort                                                    | Cost                                        | Risk it removes                               |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------- |
| **0 — Behavior & pool (DIY)**   | Per-number health from our own data; per-number daily cap; campaign number **pool** + healthiest-LRU selection; **local-presence** area-code match; auto-pull + alert | Medium (dial-path change + a number-health table + admin panel) | Just the extra Twilio numbers (~$1/mo each) | Overuse of one number; mismatched area codes  |
| **1 — Spam-score signal**       | Scheduled Twilio Lookup **Nomorobo** spam-score checks on our numbers → react/alert                                                                                   | Low                                                             | Per-lookup (pennies)                        | Flying blind on whether a number is going bad |
| **2 — Registration (the cure)** | Enroll numbers in **Twilio Voice Integrity** (or Numeracle) for proactive registration + remediation                                                                  | Low code, real onboarding                                       | Subscription + per-number                   | Getting labeled at all                        |

**Recommendation:** start with **Phase 0** — it's the highest-leverage thing we
fully control (pool + local presence + per-number caps + health tracking), needs
no vendor, and makes Phases 1–2 plug-in. Phase 2 (registration) is what actually
keeps numbers clean long-term and should be pursued in parallel as a
business/onboarding task (you provide the business identity; I wire the API).

## Open questions for you before building Phase 0

1. How many Twilio numbers are you willing to run per campaign (pool size)? (A
   handful per area-code region is the sweet spot — small + consistent.)
2. Do you already have a verified business identity in Twilio (Trust Hub / brand)
   — needed for Phase 2 registration?
3. Budget appetite for a reputation vendor (Numeracle/First Orion) vs. starting
   with Twilio-native (Voice Integrity + Nomorobo)?

## Sources

- Twilio Voice Integrity (spam remediation, Trust Hub): twilio.com/docs/voice/spam-monitoring-with-voiceintegrity
- Twilio Lookup + Nomorobo Spam Score add-on: twilio.com/en-us/blog/detect-robocalls-with-twilio-lookup-and-nomorobo
- Numeracle Number Reputation Management; First Orion AFFIRM Reputation Monitoring
- Outbound dialing best practices (per-number caps, local presence, anti-snowshoe): batchdialer / convoso / kixie / readymode guidance
