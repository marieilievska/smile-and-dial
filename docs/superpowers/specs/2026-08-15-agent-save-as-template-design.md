# Save as template — the flywheel (Phase 2) — design

Date: 2026-08-15
Status: Draft for review
Author: Marija + Claude (brainstorm)

## 1. Why we're doing this

Phase 1 shipped the template builder: a locked-Instructions + editable-Script
one-screen builder, seeded with two hand-crafted templates (Webinar, Blank). The
shelf is stocked by hand. Phase 2 makes the shelf **grow itself**: an admin turns
any proven agent — especially one imported from ElevenLabs — into a reusable
template, without hand-writing a prompt or hand-splitting instructions from
script. This is the "flywheel" from the Phase 1 spec (§9), now its own project.

The hard part — separating durable behavior (Instructions) from campaign
specifics (Script) and pulling out the key details — is done by an **AI first
pass** that the admin then **corrects on the builder screen they already know**.
The AI does the tedious work; the human keeps quality control.

Spec this builds on: `docs/superpowers/specs/2026-08-14-agent-template-builder-design.md`.

## 2. Decisions locked during brainstorm

1. **Admin-curated shared shelf (chose A).** Anyone builds agents, but only
   **admins** save templates, and a saved template appears in **everyone's**
   gallery. Protects the north star — a teammate only ever sees good starting
   points. (Not: everyone-saves-everything; not: per-user private templates —
   that's a possible future "C".)
2. **Reuse the builder as the review UX.** The AI split **pre-fills the existing
   one-screen builder** in a "template editor" mode (Instructions editable, Script
   filled, Key details extracted). No new bespoke "sort into buckets" screen.
3. **"Tidy up my wording" is in scope** — a small AI cleanup button on the Script
   prose.
4. **Edit + delete saved templates are in scope** (both admin-only). Edit reuses
   the same builder screen.

## 3. The flow

```
Agents list (admin) ──"Save as template"──▶ /settings/agents/templates/new?from=<agentId>
                                                     │
                        server: fetch the agent's prompt, run the AI split
                                                     │
                                                     ▼
                    Builder in "template editor" mode, PRE-FILLED
        (Instructions EDITABLE · Name · Description · Purpose · Goal ·
         Key details extracted · Script prose · tidy-wording button)
                                                     │
                              admin tweaks ──"Save template"──▶ agent_templates row
                                                     │
                                                     ▼
                        New card in EVERYONE's gallery (/settings/agents/new)
```

## 4. Which agents can be saved, and how we get their prompt

"Save as template" is available (to admins) on any agent. To get the source text
for the split:

- **Connected / externally-managed agent** (the main flywheel case — e.g. the
  webinar agents): fetch the live prompt via the existing
  `fetchElevenLabsAgentPrompt(elevenlabs_agent_id)`
  (`src/lib/elevenlabs/agents.ts:644`, returns the prompt string or `null`).
- **App-managed / legacy wizard agent**: use its stored `system_prompt`.
- **Template-made agent** (already has a `template_key` + structured script):
  low value to re-templatize, but supported — pass its assembled `system_prompt`.

If the source text can't be obtained (EL not live / empty / fetch fails), the
flow still opens the builder — see the fallback in §5.

## 5. The AI split

New pure-ish module `src/lib/ai/split-agent-template.ts`, mirroring the existing
`draftAgent` pattern (`src/lib/ai/draft-agent.ts`): a plain `fetch` to OpenAI in
JSON mode when `OPENAI_API_KEY` is set, a deterministic fallback otherwise.

```ts
export interface TemplateSplit {
  name: string; // suggested template name
  description: string; // one-line gallery subtitle
  instructions: string; // the durable, campaign-agnostic behavior (locked layer)
  purpose: string;
  goal: string;
  keyDetails: KeyDetail[]; // extracted facts: dates (typed "date"), names, offer…
  scriptProse: string; // the conversational flow, specifics removed
  source: "openai" | "fallback";
}

export async function splitAgentIntoTemplate(
  promptText: string,
  agentName: string,
): Promise<TemplateSplit>;
```

- **Live prompt (OpenAI):** instruct the model to separate _durable behavior_
  (turn-taking, delivery, gatekeeper/DNC/IVR handling, AI-disclosure) into
  `instructions`, put the campaign-specific pitch/flow into `scriptProse` with the
  concrete facts pulled out into `keyDetails` (any date → a `date`-typed detail),
  and write a short `purpose`/`goal`. Return strict JSON; normalize with the
  existing `normalizeKeyDetails`.
- **Proposal, not gospel.** The admin fixes everything in the builder. The split
  only has to get _close_.
- **Graceful fallback** (no key, or empty/failed source text): return
  `{ name: agentName, description: "", instructions: SHARED_INSTRUCTIONS,
purpose: "", goal: "", keyDetails: [], scriptProse: promptText, source:
"fallback" }` — i.e. drop the raw prompt into the Script and let the admin split
  it by hand on the builder. Never a hard error.

## 6. The builder in "template editor" mode

The Phase 1 `AgentBuilder` gains a template mode (via a `mode: "agent" |
"template"` prop, or a thin `TemplateEditor` wrapper reusing the same field
components — the plan decides which is cleaner). Differences from agent mode:

- **Instructions card is editable** (a textarea), because the admin is curating
  the proven behavior — not just consuming it.
- Adds a **template Name** and **Description** field (the card's name/subtitle),
  distinct from an agent's name.
- **Voice** is the template's _default_ voice.
- Save button is **"Save template"** → `saveTemplate` / `updateTemplate`, not
  `createAgentFromTemplate`.
- The live preview and `validateScript` still apply.

## 7. Data model + gallery

New table **`agent_templates`**:

```sql
create table public.agent_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  instructions text not null,
  default_voice_id text,
  tools jsonb not null default '{}'::jsonb,
  script jsonb not null default '{}'::jsonb, -- {purpose, goal, keyDetails, scriptProse, dataCollection}
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.agent_templates enable row level security;
-- Shared shelf: everyone reads; only admins write.
create policy "agent_templates_select" on public.agent_templates
  for select to authenticated using (true);
create policy "agent_templates_write" on public.agent_templates
  for all to authenticated
  using (public.is_admin((select auth.uid())))
  with check (public.is_admin((select auth.uid())));
```

- The gallery (`/settings/agents/new`) becomes **code seeds (Blank, Webinar) ＋
  the DB rows**, fetched server-side.
- Template resolution: the `/new/[template]` route resolves the param against the
  code registry first (`getTemplate("webinar"|"blank")`); if no match, it loads
  `agent_templates` by `id`. Both paths hand the builder a single `AgentTemplate`
  shape (Phase 1's type), so `AgentBuilder` is unchanged for consumers.

## 8. Managing templates (admin)

- **Delete** a saved template — a small admin-only affordance on DB template cards
  in the gallery → `deleteTemplate(id)`. (Code seeds can't be deleted.)
- **Edit** a saved template — opens `/settings/agents/templates/<id>/edit` in the
  builder's template-editor mode → `updateTemplate(id, …)`.
- Editing/deleting does **not** touch agents already created from the template
  (agents snapshot their instructions/script at creation — Phase 1 decision).

## 9. "Tidy up my wording"

New module `src/lib/ai/tidy-prose.ts` (`tidyProse(text): Promise<string>`), same
live-OpenAI / passthrough-fallback pattern. A button next to the Script prose in
the builder sends the current prose, gets back a grammar/flow-cleaned version
**with meaning preserved**, and replaces the prose with an **undo** toast so the
admin can revert. If OpenAI is unavailable, the button no-ops with a quiet notice.

## 10. Permissions (two layers, always)

- **Entry points admin-gated:** the "Save as template" button, the template-editor
  routes, and the delete/edit affordances only render for admins (role check like
  `settings/users` / `settings/api` already do).
- **Server actions require admin:** `proposeTemplateFromAgent`, `saveTemplate`,
  `updateTemplate`, `deleteTemplate` each check `role === "admin"` (mirroring
  `syncAgent`), and `agent_templates` RLS enforces admin-write as the second
  layer. Consuming templates (reading the gallery, building an agent) stays open
  to everyone.

## 11. Testing

- **vitest:** `splitAgentIntoTemplate` fallback path (deterministic:
  raw→scriptProse, default instructions); `tidyProse` passthrough fallback; the
  template resolver (code key vs DB id); `normalizeKeyDetails` already covered.
- **Playwright (contract):** admin saves an agent as a template (using the
  no-OpenAI fallback so it's deterministic and creates no external side effects),
  the new card appears in the gallery, and a non-admin does **not** see the "Save
  as template" button. As in Phase 1, the live-OpenAI/live-EL paths are not
  exercised against prod in-session.

## 12. Success criteria

- An admin turns an imported ElevenLabs agent into a shared template in a couple
  of minutes, without hand-writing or hand-splitting a prompt.
- The AI split is a _starting point_ the admin can fully correct on the familiar
  builder screen.
- The shared gallery grows with admin-approved templates; teammates keep seeing
  only good starting points.
- A bad template can be edited or pulled. Existing agents are unaffected by
  template edits.

## 13. Out of scope

- Per-user _private_ templates and an admin "promote to shared" flow (future "C").
- Auto-publishing without admin review.
- Any change to how agents themselves are created or synced (Phase 1 owns that).
- Versioning/history of templates.
