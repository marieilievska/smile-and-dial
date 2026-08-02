# Teammate onboarding + member capability expansion — design

Date: 2026-08-02
Status: Draft for review
Author: Marija + Claude (brainstorm)

## 1. Why we're doing this

Smile & Dial is being rolled out to more teammates at Referrizer. Today the
app is built for a power user who already knows every concept (the person who
built it). A brand-new teammate:

1. Accepts an invite, sets a password, and lands on `/today`.
2. Sees an empty action queue that says _"The AI is handling things in the
   background. You're free to step away."_ — actively misleading for someone
   who hasn't set anything up.
3. Gets no welcome, no guided setup, no explanation of the core concepts, and
   no idea that the built-in **Ask Smile** helper can answer how-to questions.

The pieces for a good on-ramp already exist — a setup-progress hub
(`/settings/overview`), the **Ask Smile** co-pilot, an in-app product guide,
and consistent empty states. They just aren't **assembled, sequenced, and
surfaced** into a first-run experience. This project does that.

**Scored baseline (first-time teammate experience): ~54/100 — "needs
redesign attention."** Held back by First-time motivation (3/10), Outcome
clarity (9/20), and Aha moment (1/5). Target after this work: **80+**.

## 2. Persona and scope

- **Persona:** an internal Referrizer teammate who will mostly _build_ — create
  agents, buy/manage numbers, import leads, and launch campaigns. (Confirmed:
  "most teammates are builders.")
- **Context:** they join an **already-configured** workspace. Because agents,
  campaigns, lists, and leads are owned per-user (owner-based RLS), each new
  teammate starts with their **own empty set** — they do not inherit anyone
  else's. Onboarding is therefore **per-user**: "launch _your_ first campaign,"
  not "set up the workspace."
- **In scope:** the two-role capability change (Part A) and the first-run
  onboarding experience (Part B).
- **Out of scope (future workstreams):** navigation/terminology clarity,
  per-screen contextual help, a full help center. Noted in §9.

## 3. Decisions locked during brainstorm

- Onboarding approach: **Getting-started checklist + one-time welcome primer**
  (chosen over a guided-Settings rewrite and a forced full-screen wizard).
- Step order: **Import leads → Get a number → Build agent → Launch campaign.**
- Welcome primary CTA: **"Import leads"** (jumps to step 1).
- Personalization is dynamic: greeting from `profiles.full_name`; step labels
  reflect the user's real data (their agent name, their list, their number).
- Permission model: **repurpose the existing `member` role** to include the
  builder capabilities. No new role. Two roles total: `admin`, `member`.
- Members also get: **custom fields, DNC, and the reporting hub** (with the
  guardrails in §4.2).

## 4. Part A — Permission model (repurpose `member`)

### 4.1 Capability matrix

| Area                                     | Member (everyday teammate)       | Admin   |
| ---------------------------------------- | -------------------------------- | ------- |
| Leads + import                           | ✅ own                           | ✅ all  |
| Agents (build)                           | ✅ own                           | ✅ all  |
| Lists, goals, knowledge bases, templates | ✅ own                           | ✅ all  |
| Campaigns (launch)                       | ✅ own                           | ✅ all  |
| Own calendar + email (Calendly / Close)  | ✅                               | ✅      |
| Phone numbers (shared pool)              | ✅ manage — guarded              | ✅ full |
| Custom fields                            | ✅ create + use — delete guarded | ✅ full |
| DNC list                                 | ✅ view + add — removal guarded  | ✅ full |
| Reporting / call-quality hub             | ✅ view + review own calls       | ✅ full |
| Teammates (users)                        | ❌                               | ✅      |
| API keys, system settings                | ❌                               | ✅      |

Rows already open to members today (owner-based RLS): leads, agents, lists,
goals, knowledge bases, templates, campaigns, own integrations. **No change
needed for those.** The rows that change from admin-only to member-accessible:
phone numbers, custom fields, DNC, reporting.

### 4.2 Guardrails on the newly-opened, shared/compliance-sensitive areas

These areas are **workspace-shared** (not owner-scoped) or carry compliance
risk, so "open to members" needs limits. Each is overridable by Marija.

- **DNC — removal stays admin-only.** Members can view the list and add
  numbers; **removing** a number is a TCPA risk (re-calling an opt-out) and
  stays with admins. The AI's auto-add on request is unchanged.
- **Phone numbers — no yanking others' numbers.** Members can buy, adopt, and
  manage numbers that are unattached or attached to **their own** campaigns.
  Releasing/deleting a number attached to **another user's** campaign stays
  admin-only.
- **Custom fields — delete stays admin-only.** Deleting a field destroys that
  column's data workspace-wide. Create and edit are open to members.
- **Reporting — read + review-your-own for members.** Viewing analytics and
  reviewing/flagging calls is open. The **shared call-review rubric** and the
  **"apply a prompt suggestion to a live agent"** action stay admin-only (they
  affect shared config / other people's agents).

### 4.3 Implementation surface (what actually changes)

- **RLS policies** (live-DB migration) on the affected tables so `member` is
  allowed where the matrix says, with the §4.2 carve-outs expressed as policy
  conditions (e.g. DNC delete still `is_admin`; number release checks the
  attached campaign's owner). Tables involved: `twilio_numbers`,
  `custom_field_defs`, the DNC tables, and the reporting/analytics + call-review
  tables. **Additive/relaxing changes only — no column drops or renames.**
- **Page guards:** remove the `role !== "admin"` redirects on
  `/settings/twilio-numbers` and `/settings/custom-fields`; open `/reporting`
  (drop `adminOnly` on its nav item) with the review-curation controls
  conditioned on `isAdmin`. `/settings/users` and `/settings/api` keep their
  admin redirects.
- **Nav + Settings overview:** show the Numbers / Custom fields / Integrations
  cards to members (move them out of the strictly `isAdmin` block, or introduce
  an "essentials everyone needs" grouping). Keep Users / API keys admin-only.
- **Settings overview readiness logic:** count a phone number as an essential
  for **everyone** now (see §5.4), so members no longer see a false "ready to
  make calls."
- **Invite dialog copy:** update the `member` role helper text to reflect the
  expanded capability ("Builds and runs calls: agents, leads, numbers,
  campaigns, reporting. Not teammates or API keys.").

### 4.4 Migration safety

- One relaxing RLS migration; verify each policy on a branch/preview before
  `supabase db push` to prod.
- Because policies only **widen** access, existing admin behavior is unchanged.
- Confirm the app's service-role paths (dialer, webhooks) are unaffected — they
  bypass RLS and shouldn't care.

## 5. Part B — Onboarding experience

### 5.1 The welcome primer (shown once)

- **Trigger:** first authenticated page load when `profiles.welcome_seen_at`
  is null. Modal over `/today`.
- **Content:** greeting ("Welcome to Smile and Dial, {firstName}"), one-line
  value ("Your AI makes the calls. You set it up once — four pieces fit
  together."), and the four building blocks in order:
  1. **Leads** — the businesses to call.
  2. **Number** — the line calls go out from.
  3. **Agent** — your AI caller: its voice and goal.
  4. **Campaign** — ties them together and starts calling.
- **Actions:** primary **"Import leads"** → `/leads/import`; secondary
  **"Explore on my own"** → dismiss. Either sets `welcome_seen_at`.
- **Helper line:** "Stuck anywhere? Ask Smile, top-right — it knows every step."
- Only shows once; never blocks the app after dismissal.

### 5.2 The "Getting started" checklist

- **Home:** a card on `/today` (above the action queue) **plus** a "Setup N/4"
  pill in the top bar so it's reachable from any page until finished.
- **Steps (per-user, in order):**
  1. **Import your leads** — done when the user owns ≥1 lead. CTA → `/leads/import`.
  2. **Get your phone number** — done when a number is available to the user
     (an unattached pool number they can use, or one they've added). CTA →
     `/settings/twilio-numbers`.
  3. **Build your AI agent** — done when the user owns ≥1 agent. CTA →
     `/settings/agents/new`.
  4. **Launch your campaign** — done when the user owns ≥1 active campaign.
     CTA → `/campaigns`.
- **Optional step (below a divider):** "Connect your calendar and email" — so
  the AI can book meetings and send info. Done when Calendly or Close is
  connected. Not counted in the N/4.
- **Completion source of truth:** the same per-user counts the Settings
  overview already computes — no separate tracking that could drift.
- **The next incomplete step** gets the "Start here" emphasis and a primary
  button; completed steps show a check + the real value (e.g. the number, the
  list name); later steps are muted.
- **Dismiss:** "Hide for now" sets `profiles.onboarding_dismissed_at`; the
  card disappears but the top-bar pill remains until all four are done.
- **Ask Smile** is surfaced in the card footer ("Ask Smile if you get stuck").

### 5.3 The success state (first win)

- When all four steps complete, the card flips to a success state:
  "You're live — {agentName} is dialing," with "Watch calls land on Today, or
  review how they went in Reporting." Actions: **Go to Today**, **View
  campaign**.
- After this, the checklist card and top-bar pill retire (the pill can briefly
  show a green "Setup complete" then disappear on next load).

### 5.4 Fix the misleading readiness message

- Today a member can be told "ready to make calls" with no number in view.
  With numbers now visible to members and counted as an essential for everyone,
  the Settings-overview banner and the Today empty state must both require an
  actual usable number before claiming readiness. The Today action-queue empty
  copy ("The AI is handling things… free to step away") must not show to a user
  who hasn't launched a campaign yet — replace with the getting-started nudge.

### 5.5 Storage

Two additive columns on `profiles` (safe, no drops):

- `welcome_seen_at timestamptz` — gates the one-time welcome modal.
- `onboarding_dismissed_at timestamptz` — user hid the checklist card.

Step completion itself is **derived from data**, not stored, so it can't lie.

## 6. Copy (all outcome-based, sentence case)

- Welcome title: "Welcome to Smile and Dial, {firstName}"
- Welcome subhead: "Your AI makes the calls. You set it up once — four pieces
  fit together."
- Blocks: "Leads — the businesses to call." / "Number — the line calls go out
  from." / "Agent — your AI caller: its voice and goal." / "Campaign — ties
  them together and starts calling."
- Welcome CTAs: "Import leads" / "Explore on my own"
- Checklist title: "Getting started" · progress "N of 4 done"
- Steps: "Import your leads" / "Get your phone number" / "Build your AI agent"
  / "Launch your campaign" · optional "Connect your calendar and email"
- Footer: "Ask Smile if you get stuck" · "Hide for now"
- Success: "You're live — {agentName} is dialing." / "Watch calls land in real
  time on Today, or review how they went in Reporting." · "Go to Today" /
  "View campaign"

## 7. States to design

- **Empty / step 0:** welcome primer, then a 0/4 checklist.
- **In progress:** N/4 with "Start here" on the next step; done steps show real
  values.
- **Dismissed:** card hidden; top-bar pill persists until complete.
- **Loading:** checklist reads live counts; skeleton rows while counts resolve.
- **Complete:** success state, then retire.
- **Error:** if a count query fails, the checklist degrades to links (never
  blocks the page).

## 8. Cross-screen implications

- `/today` — hosts the welcome modal, the checklist card, and the corrected
  empty-state copy.
- Top bar — new "Setup N/4" pill (reuses the Ask Smile neighbourhood).
- `/settings/overview` — readiness logic now counts numbers for everyone;
  Numbers / Custom fields cards visible to members.
- `/settings/twilio-numbers`, `/settings/custom-fields`, `/reporting`,
  `/dnc` — guards relaxed to members per §4, with the §4.2 carve-outs.
- Invite dialog — member role helper copy updated.
- Ask Smile product guide — verify the "who can do what" lines still match the
  new two-role reality (e.g. the users/numbers topics).

## 9. Out of scope (future workstreams)

1. Navigation + terminology clarity (do the words explain themselves?).
2. Per-screen contextual help (what is "connect rate", "autopilot", "goal"?).
3. A dedicated help center / expanded Ask Smile surface.

These were part of the original audit and remain queued; this spec is
workstream #1 only.

## 10. Build phases + testing

- **Phase 0 — capability change (Part A).** RLS migration + guard/nav updates +
  invite copy. Ship first; it's the prerequisite for the numbers step.
- **Phase 1 — welcome + checklist + pill + readiness fix (Part B).**
- **Phase 2 — success state + polish.**
- **Tests (Playwright, as contract):** a member can reach Numbers / Custom
  fields / Reporting; a member cannot reach Users / API keys; DNC removal is
  blocked for members; the welcome shows once; the checklist reflects real
  per-user progress and hides on completion; the false "ready to make calls" is
  gone. (Specs run against the live env, so they're written but not run here.)

## 11. Success criteria

- A brand-new member, from first login, can get to a live campaign guided, with
  no tribal knowledge.
- No member ever sees a "you're done / ready" message that isn't true.
- Experience score for the first-time teammate experience: 54 → 80+.
