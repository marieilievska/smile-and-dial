# Agent template builder — replace the from-scratch wizard — design

Date: 2026-08-14
Status: Draft for review
Author: Marija + Claude (brainstorm)

## 1. Why we're doing this

Creating an agent is the weakest point of Smile & Dial. Today `Settings →
Agents → Build new agent` is a **10-step wizard** (Basics → Personality →
Environment → Tone → Goal → Guardrails → Tools → Knowledge base → Data &
evaluation → Review). It asks a non-expert to invent, from a blank page, the
things that actually make an agent good: personality, tone, guardrails, turn-
taking discipline. A teammate who has never written an agent prompt cannot fill
those boxes well, so the wizard reliably produces a **mediocre agent** — and
then the whole campaign underperforms because of it.

The insight driving this redesign (Marija's): **the hard, valuable part is
already done and proven.** We have live webinar agents ("HireAI Webinar Reason
First" and "Pattern Interrupt") that sound human and handle real calls well. A
person creating a new agent should **start from that proven work**, not from
nothing — and should only be able to change the parts that are genuinely
theirs to change.

### Two layers hiding inside every good agent

Pulling the real live prompt apart (agent `agent_1501kzdv…`, ~11k chars) shows a
clean seam between two very different kinds of content:

- **Instructions — how the agent _behaves_.** Durable, campaign-agnostic, and
  subtle: ask exactly one question then stop and wait; natural human delivery
  (fillers, laughs, react to pain points); the gatekeeper ladder (owner →
  schedule callback → only then a manager); mark-DNC only when the caller asks
  unprompted; answering-machine / IVR handling; robustness to speech-to-text
  errors; admit it's AI with humor; outbound sign-off discipline. **This is the
  part that is "already best." A teammate should never touch it — and honestly
  should not be _allowed_ to, because it is easy to break and hard to rebuild.**

- **Script — what the agent is _for_ and what it _says_.** Campaign-specific:
  the purpose, the goal, the rep name, the pitch, the objection replies, the
  sign-off, and the concrete facts (event name, date, time). **This is the only
  thing that should change from one agent to the next.**

Proof the seam is real: we already run two agents — "Reason First" and "Pattern
Interrupt" — that share the **same instructions** and differ only in **script**.
We are already A/B-testing the script while holding behavior fixed. This design
just turns that de-facto practice into a feature.

### The landmine this removes

In the live prompt the event date **"August 27th" is typed as literal text in
~3 separate places**, plus a per-timezone time table. To reuse that agent for a
September event, someone must hunt through 11,000 characters and change every
occurrence; miss one and the agent confidently invites people to a date that
already passed. Making the date a **single typed field** the system injects
everywhere eliminates this class of bug entirely — for any purpose, not just
webinars.

## 2. North star, persona, scope

- **North star (non-negotiable):** _the least techy person can use this and use
  it well._ Every decision below answers to that bar. No prompt-writing, no
  `field_name`/`enum` jargon, plain English + examples everywhere, foolproof by
  construction.
- **Persona:** an internal Referrizer teammate (a "builder", per the teammate-
  onboarding work) who self-serves — creates their own agent without Marija.
  This is the **"Build agent"** step of the teammate-onboarding checklist
  (`2026-08-02-teammate-onboarding-design.md`); this project is what makes that
  step succeed instead of intimidate.
- **In scope (Phase 1):** the create-from-template experience, the seeded
  starting templates, the live preview, and save-blocking validation.
- **In scope (Phase 2):** the "Save as template" flywheel and the AI wording
  cleanup. (See §9.)
- **Out of scope:** a new test-call mechanism — the campaign **Test call tab**
  (`src/app/(app)/campaigns/test-call-tab.tsx`) already runs a real live mic
  conversation against the campaign's actual agent. The builder's job is to
  produce a good agent; testing stays where it lives today.

## 3. Decisions locked during brainstorm

1. **Positioning (chose A):** a **template gallery becomes the front door**. The
   existing 10-step wizard is demoted to a quiet **"Advanced — build from
   scratch"** link, not deleted.
2. **Audience (chose A):** **teammates self-serve.** Instructions hard-locked;
   script heavily guided; foolproof.
3. **Reframe (Marija):** this is **not** a webinar template. It is a **proven
   behavior chassis** (locked instructions) onto which any purpose bolts a
   different body (script/purpose/goal). Webinar is merely the first body.
4. **Editing model (chose 3 → then generalized to 1):** hybrid — structure the
   dangerous/reusable facts, keep the conversational script as editable prose —
   using **one universal skeleton for every purpose** (a survey and a webinar
   use the identical screen; only the pre-filled content differs).
5. **"Offer/event" generalized to "Key details"** — a typed, pre-seeded list of
   the facts _this_ agent needs. Nothing on screen says "event" unless the
   template has one.
6. **Data collection is promoted out of "Advanced"** into its own explained,
   editable section. **Tools stay fixed/locked. Success rules default from the
   Goal.**
7. **Flywheel (Marija):** as agents are imported into Smile & Dial, we can
   **build templates from them** — Phase 2.
8. **Phasing:** builder first (Phase 1), flywheel second (Phase 2).
9. **Reuse the existing campaign Test call** — no new test button.

## 4. The one screen (Phase 1)

Replaces the 10 steps with a **single page**, same shape for every purpose:

```
New agent                                            One screen · no steps
Starting from: [ Webinar invite ▾ ]   ← change the card to start elsewhere

┌ Agent name ─────────────┐  ┌ Voice ▾ ┐
└─────────────────────────┘  └─────────┘

🔒 Instructions — how the agent behaves          Locked · proven
   [ one question then wait ] [ human delivery ] [ gatekeeper ladder ]
   [ DNC only if asked ] [ voicemail/IVR ] [ admits it's AI ]
   You can't break this, and don't need to.  (Admins can edit — §7)

✏️ Script — what it says & what it's for          Edit freely
   Purpose  ......................................
   Goal (what counts as success) ................
   ┌ Key details (pre-seeded, typed) ─────────────────────┐
   │ Event name [....]   Date [📅 date-picker]   Time [..] │
   │ ↳ one date field, dropped in everywhere; time auto-   │
   │   adjusts to each lead's timezone                     │
   └──────────────────────────────────────────────────────┘
   The script  [ pre-filled prose the teammate rewrites ]
   What to collect on each call
     • "Are they the decision-maker?"          (plain English)
     • [ + add ]

▸ Advanced   Tools · Success rules            Defaults set from template ✓

                                          [ Cancel ]  [ Save agent ]
```

Field-by-field:

- **Name, Voice** — two boxes. Voice from the existing fixed roster
  (`FIXED_VOICES`); model stays fixed at `gpt-5.4` (unchanged from today).
- **🔒 Instructions** — a read-only card summarizing the locked behavior as
  chips. Not editable by teammates. Sourced from the chosen template (§7).
- **Purpose / Goal** — one line each. The **Goal** is what drives the automatic
  success rule (§6).
- **Key details** — the generalized replacement for "Offer". A pre-seeded,
  **typed** list of the facts this agent needs. Each detail has a plain-English
  label, a value, and a type (text / **date** / time). Dates render as date-
  pickers. The template decides the seed set:
  - Webinar → Event name · Date · Time
  - Survey → What we're surveying · The questions
  - Win-back → The offer · Expires
  - Blank → empty; the teammate adds their own
- **The script** — one pre-filled prose editor (the whole conversational flow).
  Universal across purposes; the template supplies great starting words. The
  teammate rewrites freely. Raw dates/names are **not** embedded here — they
  live in Key details and are injected at assembly (§8), so the prose can say
  "the event" and never go stale.
- **What to collect** — plain-English rows ("What should the agent find out and
  note on each call?"), pre-seeded, fully editable. Backed by the existing
  `extra_data_collection` structure; the machine field id is auto-derived from
  the label via the existing `toFieldId()` — the teammate never sees a slug.
- **Advanced** (collapsed, rarely opened) — **Tools: fixed** (template default,
  shown read-only). **Success rules: auto-built from the Goal**, shown but not
  fussy; power users can add extra criteria here (today's manual
  `extra_evaluation` builder lives here as the escape hatch). **Knowledge base**
  attachment (from the old wizard's step 8) also lives here — capability kept,
  hidden by default.

### Editing an existing agent

Editing a template-made agent uses **this same one-screen editor** — Script
editable, Instructions locked — not the old wizard. (The old wizard is reachable
only via the "Advanced — build from scratch" entry point.)

### Live preview (the confidence-builder)

Because the teammate never reads a prompt, a **live preview** renders how the
call will actually sound and updates as they type — e.g. _"Tom will open with:
Hi Jamie, honestly calling a little out of the blue…"_ It is **deterministic**
(no AI, instant): placeholders (`[name]`, `[industry]`, the Key details) are
filled with representative sample values, reusing the same sample-context idea
already in the Test call tab (`owner_name: "Alex (test)"`, `category: "fitness
studio"`, `lead_timezone: "America/Chicago"`, etc.). This lets a non-techy
person _see that it's good_ before saving.

### Validation

Save is **blocked with a kind message** when a required field is empty
(Name, Purpose, Goal, and any Key detail marked required — e.g. an empty event
Date). This is the structural guarantee that the date-landmine cannot recur.

## 5. How you start — the gallery

Clicking **"Build new agent"** shows a small gallery of cards. Every card shares
the **same locked-instructions chassis** and differs only in pre-filled script:

- **Webinar invite** — seeded from the real proven webinar agent.
- **Blank / from scratch** — inherits the instructions, empty script. The honest
  choice when no starting point fits. (Confirmed in scope.)
- (Room for more seeds — e.g. Appointment reminder — but not required for
  Phase 1 to ship value.)

Pick the closest → the one screen opens pre-filled → edit → Save.

The old 10-step wizard survives behind an **"Advanced — build from scratch"**
link for the rare power user who wants the raw block-by-block flow.

## 6. Tools, success rules, data collection — the split

- **Tools = plumbing, fixed.** The template sets the right tools on (e.g. book
  appointment, schedule callback, send email/text, mark DNC). Shown read-only in
  Advanced. Backed by existing `tools_enabled`.
- **Success rules = auto from Goal.** The Goal field generates the "goal met"
  evaluation criterion automatically (the app already treats the goal as the
  primary success signal). Extra criteria remain addable in Advanced for power
  users.
- **Data collection = the teammate's decision, explained.** Distinct from tools:
  what the agent should _find out_ changes with purpose. First-class, plain-
  English, editable. Backed by existing `extra_data_collection`.

## 7. Where the locked instructions live (decided: per-template)

**Decided: instructions are per-template, snapshotted onto the agent at
creation.**

- A **template owns its own locked-instructions block** (captured from the agent
  it was built from). The webinar template's instructions are the proven ones.
  This directly supports the flywheel (§9): a newly imported agent brings its own
  behavior, which becomes _its_ template's instructions — we are not forcing
  every future purpose to conform to one global behavior block.
- When an agent is created from a template, the instructions are **snapshotted
  onto the agent**, so later editing a template does **not** silently change live
  agents. Admins can edit a template's instructions in one place; a
  "re-apply template instructions" action can push updates to existing agents on
  demand (mirrors the existing per-agent "Sync" / "Re-sync all").
- **Teammates:** instructions are read-only. **Admins:** can edit a template's
  instructions from Settings.

> Resolved 2026-08-14: per-template chosen over one shared global block, for
> flexibility + the flywheel. In practice the seed templates can still share the
> same proven instructions — per-template just means they aren't _forced_ to.

## 8. Under the hood (plain English)

- The final ElevenLabs prompt is **assembled by the app** = `locked instructions`
  - `Purpose` + `Goal` + `The specifics` (Key details rendered as a clean facts
    block — this is where the date lives, once) + `the Script prose` + the existing
    shared blocks (lead context, tool usage, tool-error handling). This extends
    today's `assemblePrompt()` (`src/lib/agents/prompt.ts`), which currently glues
    personality/environment/tone/goal/guardrails.
- Timezone handling for times stays in the **locked instructions** (the proven
  prompt already computes event time from `{{lead_timezone}}`), so Key details
  only need a base time.
- **Import-and-split, brick one:** today's proven agents are
  `externally_managed` — built directly in ElevenLabs; **our DB does not store
  their prompt** (verified: `system_prompt` length 0, `prompt_*` all null). So
  the first task is to **fetch that proven prompt once and split it** into the
  webinar template's instructions + script skeleton. For the seed, we do this
  split by hand (it is essentially done — see the analysis in §1).
- Agents created from a template are **app-managed** (we own and assemble their
  prompt), so edits are safe and repeatable, and the existing `syncAgent` /
  `resyncAllAgents` machinery pushes changes to ElevenLabs.

### Data model (logical; exact migration deferred to the plan)

- **Templates (Phase 1):** seed 2 templates as **code constants** (a TS module) —
  no migration needed to ship. Each template = `{ key, name, description, icon,
instructions (text), script skeleton: { purpose, goal, keyDetails[],
scriptProse, dataCollection[], tools, defaultVoice? } }`.
- **Templates (Phase 2):** introduce an `agent_templates` table for user-saved
  templates; the gallery reads code seeds + DB templates together.
- **Agents:** reuse existing columns where possible (`prompt_goal`,
  `system_prompt`, `tools_enabled`, `extra_data_collection`, `extra_evaluation`,
  `voice_id`). Add a small number of new columns for the new layer, likely:
  `template_key`, `instructions` (snapshot), `prompt_purpose`, `key_details`
  (JSON), and a script-prose column. Precise schema is a planning task.

## 9. Phase 2 — the flywheel + polish

- **"Save as template"** on any agent — crucially including a freshly **imported**
  ElevenLabs agent (`connectAgent`) — runs an **AI-assisted split** that proposes
  which text is durable behavior (instructions) vs this-campaign script, and
  extracts Key details (dates, names, offer). An **admin reviews/approves in one
  click**; the result becomes a reusable template. The teammate never sees this;
  it is a curator action. This is how the shelf grows without hand-writing
  prompts. (Uses OpenAI, consistent with existing `draftAgent` / extraction
  usage.)
- **"Tidy up my wording"** — an optional AI cleanup on the Script prose that
  fixes grammar/flow without changing meaning.

## 10. Success criteria

- A teammate who has never built an agent can create a good, ready-to-run agent
  from a template in a few minutes, without writing a prompt or seeing jargon.
- It is **structurally impossible** to ship an agent with a blank/stale date or
  missing purpose/goal.
- The locked instructions are byte-for-byte the proven behavior; teammates cannot
  alter them.
- The old 10-step wizard still works for power users behind the Advanced link.
- Feeds the teammate-onboarding "Build agent" step so it becomes a win, not a
  wall.

## 11. Resolved decisions (2026-08-14)

1. **Instructions model:** **per-template**, snapshotted onto the agent at
   creation (§7).
2. **Phase 1 seed set:** **Webinar + Blank** only. More seeds (e.g. Appointment
   reminder) added later once we see what people reach for.
3. **Editing an existing agent:** uses the **same new one-screen editor**
   (Script editable, Instructions locked), not the old wizard (§4).
4. **Knowledge base:** **folded into Advanced** — capability kept, hidden by
   default (§4, §6).
