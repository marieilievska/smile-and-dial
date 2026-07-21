# Live Front-Desk Demo — Design

**Date:** 2026-07-21
**Status:** Design — pending user review, then implementation plan
**Owner context:** Mid-call sales moment. When a prospect doubts that an AI can
handle their phone, the agent researches their business live, switches voice, and
plays _their_ front desk for 60–90 seconds — then pivots back to booking.

---

## 1. Problem & goal

The hardest objection on these calls is imagination: a salon owner cannot picture an
AI answering their phone, so "does it actually sound human?" and "how would that even
work for us?" stall the call. Today the agent can only _describe_ the product.

**Goal:** give the agent a tool that turns that objection into the pitch. Mid-call,
same call, no transfer: the agent looks up the prospect's business on the web, adopts
a second voice, and role-plays their receptionist while the prospect plays a customer
calling in. Then it steps back into its own voice and closes for the meeting.

**Secondary goal (free byproduct):** every demo permanently enriches the lead record
with what the research found.

**Non-goals:** provisioning a real, usable AI receptionist for the prospect; creating
per-lead ElevenLabs agents; pre-researching the whole lead database.

---

## 2. Platform facts — VERIFIED (do not re-litigate in the plan)

Confirmed against the ElevenLabs / OpenAI docs and this codebase on 2026-07-21:

1. **A tool's return value is fed to the live LLM as context.** Our six existing
   server tools already rely on this (`ToolWebhookResult.message`, consumed in
   `src/app/api/elevenlabs/tools/[tool]/route.ts`). So a tool can hand the agent a
   persona mid-call and the agent will act on it. No new mechanism needed.
2. **ElevenLabs supports multiple voices per agent.**
   `conversation_config.tts.supported_voices` takes entries of
   `{label, voice_id, language?, description?}`, **max 10 including the default**.
   The LLM switches voice by wrapping text in `<LABEL>…</LABEL>` markup —
   case-sensitive, no nesting. Returns to the default voice automatically when no tag
   is present. Switching adds negligible latency after first use.
   ([docs](https://elevenlabs.io/docs/eleven-agents/customization/voice/multi-voice-support))
3. **Agent-to-agent transfer exists but is the wrong tool here.** It preserves the
   transcript on the same call, but the receiving agent's prompt and voice are fixed
   and **dynamic variables cannot be passed to it** — so it cannot be personalised per
   business. Rejected.
   ([docs](https://elevenlabs.io/docs/eleven-agents/customization/tools/system-tools/agent-transfer))
4. **The agent can speak filler while a tool runs.** `soft_timeout_config` supports
   `additional_soft_timeout_messages` (up to 7) and
   `max_soft_timeouts_per_generation` (1–8, **default 1**). We currently set
   `timeout_seconds: 3`, `use_llm_generated_message: true`, and leave the max at its
   default of 1 (`src/lib/elevenlabs/agents.ts`) — so today the agent says one filler
   and then goes silent. This must be raised for the research wait.
   ([changelog](https://elevenlabs.io/docs/changelog/2026/5/4))
5. **Lead enrichment is effectively empty in production.** Sampled 1,000 live leads
   (of 29,970): **0% have `website`, 0% `category`, 0% `google_rating`; 100% have
   `city`.** So the research step cannot lean on stored data — it must go to the web.
   Marija is populating `website` on import going forward, which will make the fast
   path the common one.
6. **OpenAI web search requires the Responses API.** `POST /v1/responses` with
   `tools: [{type: "web_search", search_context_size, filters:{allowed_domains}}]`.
   Chat Completions only supports it via the separate `gpt-5-search-api` model with no
   filtering. `gpt-5.4-mini` supports web search + structured outputs on Responses.
   **This repo has never called `/v1/responses`** — every existing OpenAI call uses
   `/v1/chat/completions`. This is new ground.
   ([docs](https://developers.openai.com/api/docs/guides/tools-web-search))
7. **We do not store an agent's voice.** The `agents` table has `ai_model` but no
   `voice_id`; voice lives only in ElevenLabs. Any server-side "pick a contrasting
   voice" logic would need an extra mid-call API round-trip. This shapes decision D4.
8. **Production agents are externally managed.** They are built in the ElevenLabs
   dashboard and connected by ID (`agents.externally_managed`), and
   `applyConnectedAgentIntegration` deliberately **never touches their prompt, voice,
   model, or guardrails**. Any agent-wizard-only feature would not reach them.

---

## 3. Decisions taken (approved 2026-07-21)

| #   | Decision                                                                                                                         | Rationale                                                                                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Role-play demo only** — no real receptionist is provisioned                                                                    | Provisioning is a second product (agent + number + hours + booking + billing). Weeks, not days.                                                                                               |
| D2  | **The AI offers it** when the prospect shows curiosity or doubt; it also honours direct requests                                 | Prospects don't know the feature exists, so request-only would almost never fire.                                                                                                             |
| D3  | **Live web research is the source of truth**, not questions asked on the call                                                    | Marija: the web lookup _is_ the point. Anything the prospect already volunteered is passed along opportunistically, but the agent asks no extra questions.                                    |
| D4  | **Framed as a sample; allowed to approximate**                                                                                   | Pre-framing ("here's roughly how this'd sound") buys forgiveness for imperfect research, which is unavoidable.                                                                                |
| D5  | **Always attached to every agent**, wizard-built and connected alike. No per-agent checkbox. The prompt decides whether it fires | Production agents are dashboard-built (fact 8) — a wizard checkbox would never reach them.                                                                                                    |
| D6  | **Demo voice synced to every agent, connected ones included**                                                                    | Purely additive: adds one labelled voice, never changes the voice an agent normally speaks in. Without it the demo runs in the same voice on the agents that matter and the effect collapses. |

---

## 4. What happens on a call

1. Prospect is engaged and skeptical — _"does it actually sound human?"_
2. Agent offers: _"Want to hear it? Give me ten seconds and I'll answer your phone as
   your front desk."_ Prospect agrees.
3. Agent calls `smiledial_demo_front_desk`, passing `{{call_id}}` and (optionally)
   anything the prospect already said about the business.
4. **While the tool runs**, the agent covers naturally — _"one sec, pulling your site
   up…"_ — via LLM-generated soft-timeout fillers.
5. Tool returns a front-desk brief. Agent sets the frame out loud:
   _"Okay, got your site. This is roughly how it'd sound — go ahead and call in."_
6. Agent switches voice via `<FRONT_DESK>…</FRONT_DESK>` and plays the receptionist.
   Prospect acts as a customer. **2–4 exchanges, hard cap ~90 seconds.**
7. Agent drops back to its own voice: _"…that's your front desk, and I built that off
   your website in ten seconds."_ → pivots straight back to the campaign's goal.

**If research fails or times out**, the tool still returns a usable generic brief and
the agent runs a shorter, vaguer demo. It never stalls and never says "the tool
failed."

---

## 5. Components

### 5.1 New server tool — `demo_front_desk`

Follows the existing pattern exactly (`SERVER_TOOL_KEYS` → `bodySchemaFor` →
`executeServerTool`). LLM-facing name `smiledial_demo_front_desk`.

Request body properties:

| Property        | Kind                  | Notes                                                                                                                                                                                            |
| --------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `call_id`       | dynamic `{{call_id}}` | Resolves lead + campaign server-side, as every tool does                                                                                                                                         |
| `tool_secret`   | constant              | Existing shared-secret validation                                                                                                                                                                |
| `heard_on_call` | LLM-filled, optional  | "Anything the caller has ALREADY told you about their business — services, who answers the phone, why people call. Leave blank if they haven't said. Do not ask them questions to fill this in." |

`response_timeout_secs` becomes **per-tool** (`buildToolConfig` hardcodes 20 for all
six today) so this one can use **25** to cover a slow search while the rest stay at 20.

**Tool description (what the LLM reads when deciding to call it) must be tightly
gated**, because the tool is attached to every agent including ones with no demo
instructions:

> Play a live sample of the prospect's own AI front desk. ONLY call this when your
> system prompt explicitly authorises a front-desk demo AND the caller has agreed to
> hear one. Never call this to answer a general question about the product.

### 5.2 Research module — `src/lib/openai/business-research.ts`

New file. `researchBusiness({ company, city, state, website, heardOnCall })` →
`FrontDeskBrief`.

- `POST https://api.openai.com/v1/responses`, model `gpt-5.4-mini`,
  `tools: [{ type: "web_search", search_context_size: "low" }]`.
- **When `lead.website` exists**, pass `filters.allowed_domains: [<their domain>]` —
  this pins the search to their own site: faster and far more accurate than an open
  search.
- **When it doesn't**, open search on `"<company>" <city> <state>`.
- Structured output (JSON schema) — the model returns **only these fields**, never raw
  page text:

  ```
  found                    boolean
  business_name_spoken     string        how a receptionist would say it
  what_they_do             string        one line
  services                 string[]      3–5
  common_caller_reasons    string[]      3
  receptionist_greeting    string        the exact opening line
  do_not_claim             string[]      things research could NOT verify
  source_url               string | null
  ```

- **Hard 12s timeout.** On timeout, error, or `found: false`, return a generic brief
  built from company + city so the demo still runs.
- **Prompt-injection containment:** we fetch third-party websites and feed the result
  into a live call. Returning only these structured fields — never page text — is the
  containment boundary. ElevenLabs' `prompt_injection` guardrail is already on.

### 5.3 Research cache — new table `lead_business_profiles`

```
lead_id      uuid  primary key  references leads(id) on delete cascade
brief        jsonb not null
source_url   text
researched_at timestamptz not null default now()
```

Read before searching; refresh if older than 90 days. Stops us paying twice when a
lead is demoed on two calls, and makes the second demo instant.

**Write-back to the lead** (the secondary goal in §1): when research finds a website or a
category the lead lacks, fill `leads.website` / `leads.category`. Never overwrite an
existing value — same rule the post-call webhook already follows for
`business_email`.

### 5.4 Voice + wait behaviour

Add a fixed second voice to `src/lib/elevenlabs/voices.ts` — Eryn ("Genuine,
friendly, natural"), already in the roster:

```
FRONT_DESK_VOICE = { label: "FRONT_DESK", voice_id: "kdnRe2koJdOK4Ovxn2DI" }
```

Synced as `conversation_config.tts.supported_voices` in **both** `liveSync` (wizard
agents) and `applyConnectedAgentIntegration` (dashboard agents), merged into any
`supported_voices` already present, never replacing `tts.voice_id`.

**Wait behaviour.** `soft_timeout_config` in `liveSync` currently leaves
`max_soft_timeouts_per_generation` at its default of 1 (fact 4), so after one filler
the agent goes quiet — a 10s research wait would be 7s of dead air. Raise it to **4**.
Low risk: normal turns answer in ~1s and never reach the 3s threshold twice, and
`use_llm_generated_message` is already on so the fillers are contextual
("still pulling it up…") rather than canned.

> **Change from the earlier conversation:** we discussed defaulting the demo voice to
> the _opposite gender_ of the agent's own voice. That is not buildable cheaply — we
> don't store agent voice (fact 7), so contrast would need an extra ElevenLabs lookup
> mid-call. One fixed, distinctly-different-person voice is used instead; the agent
> also frames the switch verbally, so the change is unmistakable either way. Syncing
> two labelled voices (`FRONT_DESK_F` / `FRONT_DESK_M`) and letting the prompt pick is
> a cheap v1.1 tweak if the single voice feels wrong.

### 5.5 Prompt block

New entry in `TOOL_BLOCKS` (`src/lib/agents/prompt.ts`) covering:

- **When to offer** — decision-maker reached, past the intro, and they express doubt
  or curiosity about how it sounds/works.
- **When never to offer** — gatekeeper, hostile caller, voicemail, DNC, or when
  they've already agreed to book.
- **Disambiguation from `transfer_to_number`** — "talk to the AI front desk" is a
  demo; "talk to a person / someone real" is a transfer. This collision is the single
  most likely prompt failure and needs explicit wording.
- **The frame** — always announce it's a sample built from their website _before_
  switching.
- **The mechanics** — wrap every receptionist line in `<FRONT_DESK>…</FRONT_DESK>`.
- **The demo persona never gives a personal name.** "Thanks for calling Bella Nails,
  how can I help?" — never "this is Sarah." This is what keeps the role-play out of
  post-call `owner_name` / `employee_name` extraction.
- **Honour `do_not_claim`** — deflect anything on that list with "let me grab someone
  who can confirm that."
- **The exit** — after 2–4 exchanges or ~90 seconds, switch back and close for the
  meeting.

Prompts on dashboard-built agents are edited in ElevenLabs by hand, so this block also
needs to be documented for Marija to paste into those agents.

### 5.6 Post-call containment

The transcript will contain the agent role-playing as a nail salon. Three systems read
it afterwards and will each draw the wrong conclusion:

| Reader                     | Wrong conclusion                                                             | Fix                                                                                                                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Call Reviewer              | Flags the whole call `off_script` — exactly the false-alarm class #288 fixed | Tool writes a `tool_demo_front_desk` `system_events` row against the call. `src/lib/review/playbook-data.ts` / `prompts.ts` append a line to both passes: a front-desk demo section is _intended_ behaviour |
| ElevenLabs data collection | Could extract a role-play name into `owner_name` / `employee_name`           | Prompt rule: the demo persona never gives a personal name (§5.5)                                                                                                                                            |
| 0–10 quality score         | Grades the role-play as rambling / off-message                               | Same `system_events` marker; excluded or annotated in scoring                                                                                                                                               |

### 5.7 Kill switch

`app_settings.front_desk_demo_enabled boolean not null default false`.

The handler checks it first; when off it returns
`{success: false, message: "The front-desk demo isn't available on this call — carry on normally."}`
and the agent simply moves on. **Defaults to `false`** so the migration and deploy are
inert; flipped on manually after a supervised test call. Also gives a
no-deploy global off switch if it misbehaves on live calls.

---

## 6. Error handling

| Failure                                 | Behaviour                                                    |
| --------------------------------------- | ------------------------------------------------------------ |
| Kill switch off                         | Polite decline, agent continues (above)                      |
| `call_id` unresolvable                  | Existing generic tool failure message                        |
| Research times out (>12s)               | Generic brief from company + city; demo runs shorter         |
| Research finds nothing (`found: false`) | Same generic brief; the frame ("a sample") already covers it |
| OpenAI key missing                      | Generic brief. Feature degrades, never errors                |
| Voice label missing on the agent        | Demo still runs in the default voice — persona change only   |

Every path returns HTTP 200 with a speakable message, per the existing route contract.

---

## 7. Verification

No CI gate on this repo, so: `npx tsc --noEmit`, `npx eslint`, `npm run build` clean on
changed files.

- **Playwright** (contract, runs against live): a spec POSTing
  `/api/elevenlabs/tools/demo_front_desk` — asserts the kill-switch-off decline, and
  with it on, a brief-shaped response for a seeded lead.
- **Unit-testable seam:** brief-building is pure given a research result — the same
  shape as `planEmailSend` / `planTextSend`, which exist precisely to be tested
  without network.
- **Live:** one supervised call to a known business before flipping the kill switch.

---

## 8. Cost

- Research: one `gpt-5.4-mini` Responses call with one web-search action per demo —
  cents, cached per lead for 90 days.
- Call time: +60–120s per demo. This is the real cost, and it lands only on engaged
  decision-makers. `max_duration_seconds` is already 700s, so no cap change needed.
- Zero cost on every call where no demo happens.

---

## 9. Out of scope for v1

- Provisioning a real front desk for the prospect (D1).
- Per-lead ElevenLabs agents (shared Referrizer workspace, slow to create mid-call).
- Agent-to-agent transfer (fact 3).
- Overnight pre-research of the lead database (pays to research ~30k leads to serve a
  few hundred demos, and with no websites on file most would come back empty).
- A UI surface for reviewing demos. The `system_events` rows are the record for now.

---

## 10. Open risks

1. **Prompt discipline is the real risk, not the tech.** Knowing when to offer, when
   to shut up, and how to land back on booking is tuning over weeks of real calls —
   the same arc the Call Reviewer went through.
2. **Always-on means any agent can reach the tool** (D5). The gated description plus
   the kill switch are the mitigations; `system_events` logging will show if it fires
   where it shouldn't.
3. **First use of `/v1/responses`** in this codebase (fact 6). Small, but new.
4. **Web research quality is unknowable until tested** on real prospect businesses.
   The "it's a sample" frame (D4) is the hedge.

---

## 11. Effort

~2–3 days: tool + research module 1d; prompt + voice sync + migration ½d; post-call
containment ½d; live-call tuning ½–1d.
