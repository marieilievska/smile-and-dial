# Front-Desk Demo Tool — Design

**Date:** 2026-07-21
**Status:** Design — pending user review, then implementation plan
**Scope:** **The tool only.** A seventh server tool that researches a prospect's
business live and hands the agent a front-desk brief. Everything about _how_ a demo is
performed — the persona, the second voice, when to offer it — is per-agent
configuration, set up on a purpose-built demo agent in the ElevenLabs dashboard. Not
built here.

---

## 1. Problem & goal

The hardest objection on these calls is imagination: a salon owner cannot picture an
AI answering their phone, so "does it actually sound human?" stalls the call. Today the
agent can only _describe_ the product.

The answer is to let the agent _show_ them — mid-call, same call, it researches their
business and role-plays their front desk while the prospect plays a customer calling
in.

**What this spec builds:** the missing capability underneath that — a tool the agent
can call to get an accurate, speakable brief about the prospect's business in a few
seconds. Nothing today can do that.

**What this spec deliberately does not build:** the demo behaviour itself. Whoever
wants a demo agent builds one and writes the persona, the voice switch, and the
offer/exit rules into that agent's own prompt. That keeps a sales-demo behaviour from
leaking into Market Research and every other campaign.

**Secondary goal (free byproduct):** research fills in `leads.website`, which is empty
on essentially every lead today — and which makes every subsequent lookup for that
lead faster and more accurate.

---

## 2. Platform facts — VERIFIED (do not re-litigate in the plan)

Confirmed against the ElevenLabs / OpenAI docs and this codebase on 2026-07-21:

1. **A tool's return value is fed to the live LLM as context.** Our six existing server
   tools rely on this (`ToolWebhookResult`, consumed in
   `src/app/api/elevenlabs/tools/[tool]/route.ts`). So a tool can hand the agent a
   persona mid-call and the agent will act on it. No new mechanism needed.
2. **Adding a tool key gives us the checkbox for free.** `agent-wizard.tsx:563` maps
   over `ALL_TOOLS` and renders `TOOL_LABELS[key]` + `TOOL_HELPERS[key]`. All three of
   `TOOL_LABELS`, `TOOL_HELPERS`, `TOOL_BLOCKS` are exhaustive `Record<ToolKey, …>`, so
   **TypeScript forces** an entry in each — they are not optional extras.
3. **Connected (dashboard-built) agents already sync their checked tools.**
   `applyConnectedAgentIntegration(agentId, toolsEnabled, …)` is called on connect, on
   edit, and on "Re-sync all" (`src/lib/agents/actions.ts:169,240,349`). It merges our
   `tool_ids` in while explicitly leaving prompt/voice/model alone. **Zero new work** to
   satisfy "when connecting an existing agent it syncs to ElevenLabs."
4. **ElevenLabs supports multiple voices per agent** —
   `conversation_config.tts.supported_voices`, max 10, switched by `<LABEL>…</LABEL>`
   markup. Configurable directly in the ElevenLabs dashboard, so the demo agent's owner
   sets this up there. Out of scope for us.
   ([docs](https://elevenlabs.io/docs/eleven-agents/customization/voice/multi-voice-support))
5. **The agent can speak filler while a tool runs.** `soft_timeout_config` supports
   `additional_soft_timeout_messages` (up to 7) and `max_soft_timeouts_per_generation`
   (1–8, **default 1**). Also dashboard-configurable per agent. Relevant because the
   research wait needs covering — but it is agent config, not ours.
   ([changelog](https://elevenlabs.io/docs/changelog/2026/5/4))
6. **Lead enrichment is effectively empty in production.** Sampled 1,000 live leads (of
   29,970): **0% have `website`, 0% `category`, 0% `google_rating`; 100% have `city`.**
   The research step therefore cannot lean on stored data — it must go to the web.
7. **OpenAI web search requires the Responses API.** `POST /v1/responses` with
   `tools: [{type: "web_search", search_context_size, filters:{allowed_domains}}]`.
   Chat Completions supports it only via the separate `gpt-5-search-api` model, with no
   filtering. `gpt-5.4-mini` supports web search + structured outputs on Responses.
   **This repo has never called `/v1/responses`** — every existing OpenAI call uses
   `/v1/chat/completions`. This is the one genuinely new piece of engineering.
   ([docs](https://developers.openai.com/api/docs/guides/tools-web-search))

---

## 3. Decisions taken (approved 2026-07-21)

| #   | Decision                                                                                                                            | Rationale                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Role-play demo only** — no real receptionist is provisioned for the prospect                                                      | Provisioning is a second product (agent + number + hours + booking + billing). Weeks, not days.                                                                |
| D2  | **Live web research is the source of truth**, not questions asked on the call                                                       | The web lookup _is_ the point of the tool. Anything the prospect already volunteered is passed along opportunistically; the agent asks no extra questions.     |
| D3  | **Framed as a sample; allowed to approximate**                                                                                      | Research is never perfect. Pre-framing buys forgiveness. Enforced by the demo agent's prompt, not by us.                                                       |
| D4  | **A checkbox, exactly like the other six tools**                                                                                    | Same wizard step, same `toolsEnabled` gate, same connected-agent sync. Nothing bespoke. Unchecking it is also the off switch — no separate kill switch needed. |
| D5  | **Scope is the tool alone.** Persona, second voice, offer/exit rules, and post-call handling all live on a purpose-built demo agent | Keeps demo behaviour out of every other campaign, and keeps this change small enough to ship and verify in a day.                                              |

**Reversed from the first draft of this spec** (superseded, recorded so it isn't
re-proposed): the tool being always-on for every agent; syncing a demo voice onto
connected agents; a `lead_business_profiles` cache table; an `app_settings` kill
switch; Call Reviewer containment changes. All dropped by D4/D5. **The build now
requires no database migration at all.**

---

## 4. What we build

### 4.1 Tool registration — `demo_front_desk`

Add the key to `ALL_TOOLS`, `SERVER_TOOL_KEYS`, `TOOL_LABELS`, `TOOL_HELPERS`,
`TOOL_BLOCKS`, and `TOOL_DESCRIPTIONS`. LLM-facing name
`smiledial_demo_front_desk` (existing namespace prefix).

Request body properties (via `bodySchemaFor`):

| Property        | Kind                  | Notes                                                                                                                                                                                       |
| --------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `call_id`       | dynamic `{{call_id}}` | Resolves lead + campaign server-side, as every tool does                                                                                                                                    |
| `tool_secret`   | constant              | Existing shared-secret validation                                                                                                                                                           |
| `heard_on_call` | LLM-filled, optional  | "Anything the caller has ALREADY told you about their business — services, who answers the phone, why people call. Leave blank if they haven't said. Do not ask questions to fill this in." |

`response_timeout_secs` becomes **per-tool** (`buildToolConfig` hardcodes 20 for all
six today) so this one can use **25** to cover a slow search while the rest stay at 20.

Tool description the LLM reads when deciding to call it:

> Look up this prospect's business on the web and return a brief you can use to
> role-play their front desk. Call this only when your instructions tell you to run a
> front-desk demo and the caller has agreed to hear one.

`TOOL_BLOCKS` gets a **short, honest** entry — it is type-required, and it is what a
wizard-built agent would receive. It describes calling the tool and using the brief; it
does not attempt to encode a full demo script. A purpose-built demo agent overrides it
with its own richer prompt.

### 4.2 Handler — `executeServerTool` case in `tool-webhook.ts`

1. Resolve the call context (existing `resolveCallContext`).
2. Call `researchBusiness(...)` with the lead's `company`, `city`, `state`, `website`,
   plus `heard_on_call`.
3. Opportunistically fill `leads.website` when research identified the business's own
   site and the lead has none. **Never overwrite an existing value** — the same rule
   `sendEmail` already follows for `business_email` — and never store a directory
   listing (Yelp, Google, Facebook): that column is what pins the _next_ search, so
   letting an aggregator in would quietly degrade future research for that lead.
   `leads.category` is deliberately **not** written: it is a short taxonomy value used
   in filters and dynamic variables, and a one-line description would pollute it.
4. Log a `tool_demo_front_desk` `system_events` row (existing table) with what was
   found and how long it took, so we can see real-world hit rate and latency.
5. Return the brief as the tool result alongside a speakable `message`.

### 4.3 Research module — `src/lib/openai/business-research.ts` (new)

`researchBusiness({ company, city, state, website, heardOnCall })` → `FrontDeskBrief`.

- `POST https://api.openai.com/v1/responses`, model `gpt-5.4-mini`,
  `tools: [{ type: "web_search", search_context_size: "low" }]`.
- **When the lead has a `website`**, pass `filters.allowed_domains: [<their domain>]` —
  pins the search to their own site: faster and far more accurate than open search.
- **When it doesn't**, open search on `"<company>" <city> <state>`.
- Structured output (JSON schema). The model returns **only these fields, never raw
  page text**:

  ```
  found                  boolean
  business_name_spoken   string        how a receptionist would say it
  what_they_do           string        one line
  services               string[]      3–5
  common_caller_reasons  string[]      3
  receptionist_greeting  string        the exact opening line
  do_not_claim           string[]      things research could NOT verify
  source_url             string | null
  ```

- **Hard 12s timeout.** On timeout, error, missing API key, or `found: false`, return a
  generic brief built from company + city so the demo still runs. The tool never
  reports failure to the caller.
- **Prompt-injection containment:** we are pulling third-party websites into a live
  phone call. Returning only these structured fields — never page text — is the
  containment boundary. ElevenLabs' `prompt_injection` guardrail is already on for
  every agent.

---

## 5. Error handling

| Failure                                 | Behaviour                                     |
| --------------------------------------- | --------------------------------------------- |
| Tool unchecked on the agent             | Never attached; the LLM cannot see or call it |
| `call_id` unresolvable                  | Existing generic tool failure message         |
| Research times out (>12s)               | Generic brief from company + city             |
| Research finds nothing (`found: false`) | Same generic brief                            |
| `OPENAI_API_KEY` missing                | Generic brief. Feature degrades, never errors |

Every path returns HTTP 200 with a speakable message, per the existing route contract.

---

## 6. Verification

No CI gate on this repo, so: `npx tsc --noEmit`, `npx eslint`, `npm run build` clean on
changed files.

- **Pure seam for unit-style testing:** brief-shaping from a research result is pure,
  the same pattern as `planEmailSend` / `planTextSend`, which exist precisely to be
  tested without network.
- **Playwright** (contract, runs against live): POST
  `/api/elevenlabs/tools/demo_front_desk` for a seeded lead and assert a brief-shaped
  200 — including the degraded path, which is what runs without an OpenAI key.
- **Live smoke:** call the deployed endpoint directly with a real lead id and eyeball
  the brief for a business we can verify by hand. This is the real test of research
  quality, and it needs no phone call.

---

## 7. Cost

One `gpt-5.4-mini` Responses call with one web-search action per invocation — cents.
No cost on any call that doesn't use the tool. No added call time (the demo itself
costs call minutes, but that arrives with the demo agent, not with this change).

---

## 8. Out of scope — and who does it instead

Everything below is **per-agent setup**, done by whoever builds the demo agent, in the
ElevenLabs dashboard:

| Item                                                             | Where it's done                                                             |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------- |
| The demo persona, the offer/exit rules, honouring `do_not_claim` | The demo agent's system prompt                                              |
| The second voice + `<LABEL>` switch markup                       | ElevenLabs dashboard → agent → voice → supported voices                     |
| Filler while research runs (`max_soft_timeouts_per_generation`)  | ElevenLabs dashboard → agent → turn-taking                                  |
| Keeping role-play out of `owner_name` extraction                 | Prompt rule on the demo agent: the receptionist never gives a personal name |
| Call Reviewer flagging demo calls `off_script`                   | Contained to the demo agent; revisit only if it becomes noisy               |

Also out of scope: provisioning a real front desk for the prospect (D1), per-lead
ElevenLabs agents, agent-to-agent transfer, research caching, and overnight
pre-research of the lead database.

---

## 9. Open risks

1. **Research quality is unknowable until tested** against real prospect businesses
   with no website on file. The live smoke test in §6 is how we find out — before any
   phone call is involved.
2. **First use of `/v1/responses`** in this codebase (fact 7). Small, but new.
3. **A demo agent still has to be built and tuned** for any of this to reach a
   prospect. This spec delivers the capability, not the experience.

---

## 10. Effort

~1 day: research module ½d, tool + handler + wiring ¼d, Playwright + local
verification ¼d. No migration, no UI work, no changes to existing agents.
