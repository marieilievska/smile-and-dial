# Agent Template Builder — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 10-step from-scratch agent wizard with a template-based builder — a single screen where the proven behavioral **Instructions** are locked and only the plain-English **Script** (purpose, goal, typed key details, script prose, data collection) is editable.

**Architecture:** Templates are code constants: a shared locked-Instructions block + a pre-filled Script. A pure `assembleFromScript()` glues `instructions + purpose + goal + key-details + script prose + tool blocks + lead-context` into the ElevenLabs system prompt (reusing the existing sync layer). The event date becomes a single typed key-detail injected once, killing the "typed-in-3-places" landmine. A new one-screen client component (`agent-builder.tsx`) drives create/edit; the old wizard survives behind an "Advanced — build from scratch" route.

**Tech Stack:** Next.js 16 App Router (React 19 Server + Client components), Supabase (Postgres + RLS), ElevenLabs Convai sync, vitest (unit), Playwright (e2e). Path alias `@/` → `src/`.

**Scope guardrails:**

- **Phase 1 only.** No "Save as template" flywheel, no AI tidy (those are Phase 2 in the spec).
- **Admin-only for now.** The `agents` table RLS is `is_admin`-gated. This builder ships for admins; teammate self-serve rides on the member-role RLS change tracked in `project_teammate_onboarding` — do NOT change agent RLS in this plan.
- Spec: `docs/superpowers/specs/2026-08-14-agent-template-builder-design.md`.

---

## File Structure

**New — pure logic (`src/lib/agents/`):**

- `templates/types.ts` — `KeyDetail`, `AgentScript`, `AgentTemplate` types + `normalizeKeyDetails()`.
- `templates/instructions.ts` — `SHARED_INSTRUCTIONS` (the locked, persona-neutral behavior block).
- `templates/webinar.ts` — the seeded Webinar template (proven script, split from the live agent).
- `templates/blank.ts` — the Blank template (shared instructions, empty script).
- `templates/index.ts` — `AGENT_TEMPLATES` registry + `getTemplate(key)`.
- `assemble.ts` — `assembleFromScript()` (final prompt) + `renderKeyDetails()`.
- `validate.ts` — `validateScript()` (blocks save on blanks).
- `preview.ts` — `previewScript()` (deterministic "how the call sounds").

**Modified — logic:**

- `prompt.ts` — export the currently-private `LEAD_CONTEXT_BLOCK` and `TOOL_ERROR_HANDLING_BLOCK` so `assemble.ts` can reuse them.
- `actions.ts` — add `createAgentFromTemplate()` and `updateAgentScript()`.

**New — DB:**

- `supabase/migrations/20260814120000_agent_template_columns.sql` — adds `template_key`, `instructions`, `prompt_purpose`, `key_details`, `script_prose` to `agents`.

**New/Modified — UI (`src/app/(app)/settings/agents/`):**

- `new/page.tsx` — **repurposed** into the template gallery (was: rendered the wizard).
- `new/[template]/page.tsx` — **new** — loads a template and renders the builder.
- `new/scratch/page.tsx` — **new** — renders the old `AgentWizard` (the "Advanced" escape hatch).
- `template-gallery.tsx` — **new** — the card grid (server component).
- `agent-builder.tsx` — **new** — the one-screen client builder (create + edit).
- `[id]/edit/page.tsx` — **modified** — branch: template-made agents → `AgentBuilder`; legacy agents → `AgentWizard`.

**New/Modified — tests:**

- `tests/agent-templates.unit.test.ts`, `tests/agent-assemble.unit.test.ts`, `tests/agent-validate.unit.test.ts`, `tests/agent-preview.unit.test.ts` — new vitest.
- `tests/agents.spec.ts` — **rewritten** Playwright e2e for the new flow.

---

## Task 1: Key-detail + script + template types

**Files:**

- Create: `src/lib/agents/templates/types.ts`
- Test: `tests/agent-templates.unit.test.ts`

- [ ] **Step 1: Write the failing test** (create the file with the first cases)

```ts
// tests/agent-templates.unit.test.ts
import { describe, expect, it } from "vitest";

import { normalizeKeyDetails } from "@/lib/agents/templates/types";

describe("normalizeKeyDetails", () => {
  it("returns [] for non-arrays", () => {
    expect(normalizeKeyDetails(null)).toEqual([]);
    expect(normalizeKeyDetails("nope")).toEqual([]);
  });

  it("derives a snake_case id from the label and defaults type to text", () => {
    const out = normalizeKeyDetails([{ label: "Event Name", value: "X" }]);
    expect(out).toEqual([
      {
        id: "event_name",
        label: "Event Name",
        type: "text",
        value: "X",
        required: false,
      },
    ]);
  });

  it("keeps a valid date type and required flag, and drops entries with no label", () => {
    const out = normalizeKeyDetails([
      {
        label: "Event date",
        type: "date",
        value: "2026-08-27",
        required: true,
      },
      { label: "", value: "orphan" },
    ]);
    expect(out).toEqual([
      {
        id: "event_date",
        label: "Event date",
        type: "date",
        value: "2026-08-27",
        required: true,
      },
    ]);
  });

  it("coerces an unknown type back to text and de-dupes by id", () => {
    const out = normalizeKeyDetails([
      { label: "Note", type: "wat", value: "a" },
      { label: "note", value: "b" }, // same id -> dropped
    ]);
    expect(out).toEqual([
      { id: "note", label: "Note", type: "text", value: "a", required: false },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent-templates.unit.test.ts`
Expected: FAIL — cannot resolve `@/lib/agents/templates/types`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/agents/templates/types.ts
import {
  toFieldId,
  type ExtraDataCollectionField,
} from "@/lib/agents/data-collection";
import type { ToolsEnabled } from "@/lib/agents/prompt";

/** A key detail is one concrete fact the agent needs (event name, date, offer…).
 *  `type` drives the input control (text / date-picker / time) and how the value
 *  is rendered into the prompt. `value` for a date is an ISO `YYYY-MM-DD`. */
export const KEY_DETAIL_TYPES = ["text", "date", "time"] as const;
export type KeyDetailType = (typeof KEY_DETAIL_TYPES)[number];

export type KeyDetail = {
  id: string;
  label: string;
  type: KeyDetailType;
  value: string;
  required: boolean;
};

/** The editable half of an agent — everything a teammate can change. */
export type AgentScript = {
  purpose: string;
  goal: string;
  keyDetails: KeyDetail[];
  scriptProse: string;
  dataCollection: ExtraDataCollectionField[];
};

/** A starting point: locked proven behavior + a pre-filled script. */
export type AgentTemplate = {
  key: string;
  name: string;
  description: string;
  instructions: string;
  defaultVoiceId: string;
  tools: ToolsEnabled;
  script: AgentScript;
};

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Parse + sanitize the `key_details` jsonb stored on an agent row. Tolerant of
 *  anything malformed (returns []), derives a snake_case id from the label,
 *  drops label-less entries, coerces bad types to "text", and de-dupes by id. */
export function normalizeKeyDetails(raw: unknown): KeyDetail[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: KeyDetail[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const label = asString(rec.label).trim();
    const id = toFieldId(asString(rec.id) || label);
    if (!label || !id || seen.has(id)) continue;
    const type = (KEY_DETAIL_TYPES as readonly string[]).includes(
      asString(rec.type),
    )
      ? (asString(rec.type) as KeyDetailType)
      : "text";
    seen.add(id);
    out.push({
      id,
      label,
      type,
      value: asString(rec.value),
      required: rec.required === true,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent-templates.unit.test.ts`
Expected: PASS (4 passing).

- [ ] **Step 5: Commit**

```bash
git add src/lib/agents/templates/types.ts tests/agent-templates.unit.test.ts
git commit -m "feat(agents): key-detail + script + template types with normalizer"
```

---

## Task 2: Shared locked Instructions block

**Files:**

- Create: `src/lib/agents/templates/instructions.ts`
- Test: `tests/agent-templates.unit.test.ts` (extend)

- [ ] **Step 1: Add failing assertions**

Append to `tests/agent-templates.unit.test.ts`:

```ts
import { SHARED_INSTRUCTIONS } from "@/lib/agents/templates/instructions";

describe("SHARED_INSTRUCTIONS", () => {
  it("carries the load-bearing behaviors and no campaign specifics", () => {
    expect(SHARED_INSTRUCTIONS).toContain("exactly ONE question");
    expect(SHARED_INSTRUCTIONS).toContain("smiledial_mark_dnc");
    expect(SHARED_INSTRUCTIONS).toContain("Gatekeepers");
    // Persona-neutral: the seed webinar's specifics must NOT be baked in here.
    expect(SHARED_INSTRUCTIONS).not.toContain("HireAI");
    expect(SHARED_INSTRUCTIONS).not.toContain("Tom");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/agent-templates.unit.test.ts`
Expected: FAIL — cannot resolve `@/lib/agents/templates/instructions`.

- [ ] **Step 3: Write the implementation** (persona-neutral behavior, split out of the live agent's Role/Special-Handling sections)

```ts
// src/lib/agents/templates/instructions.ts

/** The LOCKED behavioral block shared by seeded templates. This is the "already
 *  best" part — how the agent behaves on any call, independent of what it's
 *  selling. Split out of the proven live webinar agent with all campaign
 *  specifics (name, company, event) removed — those live in the editable Script.
 *  Teammates never edit this; admins edit it by editing the template. */
export const SHARED_INSTRUCTIONS = `# How you behave on every call
You are a warm, casual, human-sounding outbound representative. You must sound incredibly natural, relaxed, and human — never like a script being read.

- Use 2–3 natural fillers per turn (e.g. "um", "uh", "honestly", "basically", "literally", "kinda", "like", "I mean", "yeah no").
- Start sentences naturally with "And", "But", or "So".
- Use [laugh] at the start of sentences frequently to keep the tone light and carefree.
- React to what the caller actually says. If they share a specific pain point, react directly to it ("Oh man, that's rough") instead of a flat "got it" and moving on.
- Always lead the call. Never end on a flat statement — guide back toward the goal with a natural question. Avoid generic questions like "makes sense?".

CRITICAL TURN-TAKING RULE: Ask exactly ONE question, then stop speaking immediately and wait for the caller's answer. Never ask a question and then immediately add another question, a clarification, or a second option in the same turn. Every question gets its own turn and waits for a reply.

# Robustness to speech-to-text errors
When the call connects, the person often states their business name and the transcription may mangle it. Do not get confused, do not address the mis-transcribed phrase, and do not deviate. Treat any opening greeting as a normal pickup, ignore nonsensical words, and proceed with your opening.

# If asked whether you're an AI
Always admit it, with humor: "Yeah actually, [laugh] you won't believe how many people don't realize it. Anyway…" then continue exactly where you left off.

# Gatekeepers
Your goal is to reach the owner (or the right decision-maker).
1. If you're speaking to a gatekeeper, do NOT ask for their email to book.
2. If the owner isn't available now but will be later, schedule a callback for the owner using smiledial_schedule_callback — get a good time and the owner's name first.
3. Only if the owner is completely unreachable (out of the business, retired) may you ask for a manager who handles day-to-day, and pitch or schedule a callback for them. Don't bypass the owner otherwise.

# Answering machines / IVRs
- If you hear "this call may be recorded", just wait silently on the line.
- If you hear "state your name and reason for calling", say your name only, then stop and wait for a real person.

# Do-not-call requests
Call smiledial_mark_dnc ONLY when the person, unprompted, explicitly asks to be removed, taken off the list, or to stop calling. NEVER offer, suggest, or hint at removal yourself. If they simply aren't interested or can't connect you, do NOT mark DNC and do NOT mention a list — just wrap up politely.

# Interruptions
Be mindful of where you stopped when interrupted. Acknowledge naturally, respond to what they said, and resume smoothly.

# Sign-off discipline
This is an outbound call. Never end by asking "Is there anything else I can help you with?" or offering general assistance. Deliver your sign-off and end the call.`;
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/agent-templates.unit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agents/templates/instructions.ts tests/agent-templates.unit.test.ts
git commit -m "feat(agents): shared locked instructions block (persona-neutral behavior)"
```

---

## Task 3: Seed templates (Webinar + Blank) and the registry

**Files:**

- Create: `src/lib/agents/templates/webinar.ts`, `src/lib/agents/templates/blank.ts`, `src/lib/agents/templates/index.ts`
- Test: `tests/agent-templates.unit.test.ts` (extend)

- [ ] **Step 1: Add failing assertions**

Append to `tests/agent-templates.unit.test.ts`:

```ts
import { AGENT_TEMPLATES, getTemplate } from "@/lib/agents/templates";

describe("template registry", () => {
  it("exposes webinar and blank", () => {
    expect(AGENT_TEMPLATES.map((t) => t.key).sort()).toEqual([
      "blank",
      "webinar",
    ]);
    expect(getTemplate("webinar")?.name).toBe("Webinar invite");
    expect(getTemplate("nope")).toBeUndefined();
  });

  it("webinar carries a required date key-detail and a filled script", () => {
    const w = getTemplate("webinar")!;
    const date = w.script.keyDetails.find((d) => d.id === "event_date");
    expect(date).toMatchObject({ type: "date", required: true });
    expect(w.script.purpose.length).toBeGreaterThan(0);
    expect(w.script.goal.length).toBeGreaterThan(0);
    expect(w.tools.schedule_callback).toBe(true);
  });

  it("blank shares the instructions but has an empty script", () => {
    const b = getTemplate("blank")!;
    expect(b.instructions).toContain("exactly ONE question");
    expect(b.script.purpose).toBe("");
    expect(b.script.keyDetails).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/agent-templates.unit.test.ts`
Expected: FAIL — cannot resolve `@/lib/agents/templates`.

- [ ] **Step 3: Write the templates + registry**

```ts
// src/lib/agents/templates/webinar.ts
import type { AgentTemplate } from "./types";
import { SHARED_INSTRUCTIONS } from "./instructions";

/** Seed template split by hand from the live "HireAI Webinar" agent. The proven
 *  behavior is in SHARED_INSTRUCTIONS; everything below is the editable script.
 *  Note: the event date lives ONLY in the `event_date` key-detail — it is never
 *  typed into the prose — so it can never go stale in multiple places. */
export const WEBINAR_TEMPLATE: AgentTemplate = {
  key: "webinar",
  name: "Webinar invite",
  description:
    "Warmly invite a local business owner to a free online event and book their seat.",
  instructions: SHARED_INSTRUCTIONS,
  defaultVoiceId: "s3TPKV1kjDlVtZbl4Ksh", // Adam — casual American male
  tools: {
    schedule_callback: true,
    get_available_times: true,
    book_appointment: true,
    send_email: true,
    send_text: true,
    mark_dnc: true,
  },
  script: {
    purpose:
      "Invite a local business owner or manager to a free online event, warmly and with no hard sell.",
    goal: "Get an explicit, certain YES to attend, then capture the owner's name and email so their seat is booked. 'Goal met' = a clear yes with an email captured.",
    keyDetails: [
      {
        id: "rep_name",
        label: "Your name",
        type: "text",
        value: "Tom",
        required: true,
      },
      {
        id: "company",
        label: "Company",
        type: "text",
        value: "HireAI",
        required: true,
      },
      {
        id: "event_name",
        label: "Event name",
        type: "text",
        value: "Answer Every Call, Book Every Lead",
        required: true,
      },
      {
        id: "event_date",
        label: "Event date",
        type: "date",
        value: "2026-08-27",
        required: true,
      },
      {
        id: "event_time",
        label: "Event time",
        type: "text",
        value:
          "1 PM Eastern — adjust to the caller's timezone: noon Central, 11 AM Mountain, 10 AM Pacific",
        required: true,
      },
    ],
    scriptProse: `1. Opener (cold): "Hi [name], uh, honestly, I'm calling you a little out of the blue here. I'm reaching out to a few [industry] to invite the owner to a free online event. You wouldn't happen to be the owner, would ya?" (Infer [industry] from {{business_name}}.)

2. Disclaimer: "Okay, I gotta throw in a quick disclaimer — I'm genuinely not trying to sell you anything. I just wanna save you a seat at the event."

3. The question (as if you just remembered it): "Oh, actually — when the [industry] is closed, or you're busy with someone and the phone rings… what usually happens to that call?" (Let them answer.)

4. The bridge: "Yeah — 'cause if you don't talk to people right when they want to, you end up chasing them for weeks. The event's about how businesses are using an AI front desk to cover the phone when they're closed, so those calls still get answered and booked instead of dying in a voicemail nobody checks."

5. Soft close: "Would you be against me saving you a seat?" — you must secure explicit, certain agreement. If hedged, confirm directly using the event date and the caller's local event time from the specifics. If they can't make that date, don't offer a recording or a callback — wrap up warmly and let them go.

6. Capture: ask them to spell their email phonetically, read it back normally to confirm, and ask them to spell their name. Only push back on a truly generic prefix (info@, contact@, admin@, office@, hello@, support@) — accept anything else.

7. Sign-off: "You're all set, [name]. Reminder'll hit your inbox the day before. Appreciate you, talk soon." Then end the call.`,
    dataCollection: [],
  },
};
```

```ts
// src/lib/agents/templates/blank.ts
import type { AgentTemplate } from "./types";
import { SHARED_INSTRUCTIONS } from "./instructions";
import { FIXED_VOICES } from "@/lib/elevenlabs/voices";

/** Empty starting point — same proven behavior, no script yet. For a purpose
 *  that matches no other card. */
export const BLANK_TEMPLATE: AgentTemplate = {
  key: "blank",
  name: "Blank / from scratch",
  description:
    "Same proven behavior, an empty script. Build any purpose from zero.",
  instructions: SHARED_INSTRUCTIONS,
  defaultVoiceId: FIXED_VOICES[0].id,
  tools: { schedule_callback: true, mark_dnc: true },
  script: {
    purpose: "",
    goal: "",
    keyDetails: [],
    scriptProse: "",
    dataCollection: [],
  },
};
```

```ts
// src/lib/agents/templates/index.ts
import type { AgentTemplate } from "./types";
import { WEBINAR_TEMPLATE } from "./webinar";
import { BLANK_TEMPLATE } from "./blank";

export * from "./types";

/** All seeded starting templates, in gallery order. */
export const AGENT_TEMPLATES: AgentTemplate[] = [
  WEBINAR_TEMPLATE,
  BLANK_TEMPLATE,
];

export function getTemplate(key: string): AgentTemplate | undefined {
  return AGENT_TEMPLATES.find((t) => t.key === key);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/agent-templates.unit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agents/templates/webinar.ts src/lib/agents/templates/blank.ts src/lib/agents/templates/index.ts tests/agent-templates.unit.test.ts
git commit -m "feat(agents): seed Webinar + Blank templates and registry"
```

---

## Task 4: Export reusable prompt blocks from prompt.ts

**Files:**

- Modify: `src/lib/agents/prompt.ts:89` (LEAD_CONTEXT_BLOCK) and `:97` (TOOL_ERROR_HANDLING_BLOCK)

- [ ] **Step 1: Add the `export` keyword to both consts**

In `src/lib/agents/prompt.ts`, change:

```ts
const LEAD_CONTEXT_BLOCK = `# Lead context
```

to

```ts
export const LEAD_CONTEXT_BLOCK = `# Lead context
```

and change:

```ts
const TOOL_ERROR_HANDLING_BLOCK = `# Tool error handling
```

to

```ts
export const TOOL_ERROR_HANDLING_BLOCK = `# Tool error handling
```

- [ ] **Step 2: Verify nothing else broke**

Run: `npx tsc --noEmit`
Expected: no new errors (these were module-private consts; exporting is additive).

- [ ] **Step 3: Commit**

```bash
git add src/lib/agents/prompt.ts
git commit -m "refactor(agents): export lead-context + tool-error prompt blocks for reuse"
```

---

## Task 5: assembleFromScript — build the final prompt

**Files:**

- Create: `src/lib/agents/assemble.ts`
- Test: `tests/agent-assemble.unit.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/agent-assemble.unit.test.ts
import { describe, expect, it } from "vitest";

import { assembleFromScript } from "@/lib/agents/assemble";
import { getTemplate } from "@/lib/agents/templates";

const webinar = getTemplate("webinar")!;

describe("assembleFromScript", () => {
  const prompt = assembleFromScript({
    instructions: webinar.instructions,
    script: webinar.script,
    toolsEnabled: webinar.tools,
  });

  it("keeps the locked behavior at the top", () => {
    expect(prompt).toContain("exactly ONE question");
  });

  it("renders purpose, goal, and the specifics block", () => {
    expect(prompt).toContain("# Your job");
    expect(prompt).toContain("# Your goal");
    expect(prompt).toContain("# The specifics");
    expect(prompt).toContain("Event name: Answer Every Call, Book Every Lead");
  });

  it("injects the date once, formatted, and never as a raw literal in the prose", () => {
    const occurrences = prompt.split("August 27, 2026").length - 1;
    expect(occurrences).toBe(1);
    expect(prompt).not.toContain("2026-08-27"); // ISO value is formatted away
  });

  it("appends enabled tool blocks and the shared lead-context + error blocks", () => {
    expect(prompt).toContain("## smiledial_schedule_callback");
    expect(prompt).toContain("{{last_call_summary}}");
    expect(prompt).toContain("# Tool error handling");
  });

  it("omits empty sections without throwing", () => {
    const blank = getTemplate("blank")!;
    const p = assembleFromScript({
      instructions: blank.instructions,
      script: blank.script,
      toolsEnabled: blank.tools,
    });
    expect(p).not.toContain("# The specifics");
    expect(p).not.toContain("# Your job");
    expect(p).toContain("exactly ONE question");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/agent-assemble.unit.test.ts`
Expected: FAIL — cannot resolve `@/lib/agents/assemble`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/agents/assemble.ts
import {
  ALL_TOOLS,
  LEAD_CONTEXT_BLOCK,
  TOOL_ERROR_HANDLING_BLOCK,
  TOOL_BLOCKS_PUBLIC as TOOL_BLOCKS,
  type ToolsEnabled,
} from "@/lib/agents/prompt";
import type { AgentScript, KeyDetail } from "@/lib/agents/templates/types";

/** Human-format a key detail's value for the prompt. Dates become e.g.
 *  "Wednesday, August 27, 2026"; everything else passes through verbatim. */
function formatDetailValue(d: KeyDetail): string {
  if (d.type === "date" && /^\d{4}-\d{2}-\d{2}$/.test(d.value)) {
    const parsed = new Date(`${d.value}T00:00:00`);
    if (!Number.isNaN(parsed.getTime())) {
      return new Intl.DateTimeFormat("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      }).format(parsed);
    }
  }
  return d.value;
}

/** Render the filled key details into a single "specifics" block, or "" if none
 *  have a value. This is the ONE place a fact like the event date appears. */
export function renderKeyDetails(details: KeyDetail[]): string {
  const filled = details.filter((d) => d.value.trim().length > 0);
  if (filled.length === 0) return "";
  const lines = filled.map((d) => `- ${d.label}: ${formatDetailValue(d)}`);
  return `# The specifics — use these exact facts\n${lines.join("\n")}`;
}

export type AssembleInput = {
  instructions: string;
  script: AgentScript;
  toolsEnabled: ToolsEnabled;
};

/** Glue the locked instructions + editable script + shared blocks into the
 *  final ElevenLabs system prompt. Empty script sections are omitted. */
export function assembleFromScript(input: AssembleInput): string {
  const { instructions, script, toolsEnabled } = input;
  const sections: string[] = [instructions.trim()];

  if (script.purpose.trim())
    sections.push(`# Your job\n${script.purpose.trim()}`);
  if (script.goal.trim()) sections.push(`# Your goal\n${script.goal.trim()}`);

  const specifics = renderKeyDetails(script.keyDetails);
  if (specifics) sections.push(specifics);

  if (script.scriptProse.trim())
    sections.push(`# What to say\n${script.scriptProse.trim()}`);

  const enabled = ALL_TOOLS.filter((k) => toolsEnabled[k]);
  if (enabled.length > 0) {
    sections.push(
      "# Tools\n\n" + enabled.map((k) => TOOL_BLOCKS[k]).join("\n\n"),
    );
  }

  sections.push(LEAD_CONTEXT_BLOCK);
  sections.push(TOOL_ERROR_HANDLING_BLOCK);

  return sections.join("\n\n");
}
```

- [ ] **Step 4: Export TOOL_BLOCKS from prompt.ts**

`assemble.ts` needs the tool blocks. In `src/lib/agents/prompt.ts`, the `TOOL_BLOCKS` const is module-private. Add a public alias at the end of the file (keeps the internal name stable):

```ts
/** Public alias so the template assembler can reuse the same tool copy the
 *  wizard uses. Same object — do not fork the tool wording. */
export const TOOL_BLOCKS_PUBLIC = TOOL_BLOCKS;
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/agent-assemble.unit.test.ts`
Expected: PASS (5 passing).

- [ ] **Step 6: Commit**

```bash
git add src/lib/agents/assemble.ts src/lib/agents/prompt.ts tests/agent-assemble.unit.test.ts
git commit -m "feat(agents): assembleFromScript — instructions + script -> final prompt"
```

---

## Task 6: validateScript — block save on blanks

**Files:**

- Create: `src/lib/agents/validate.ts`
- Test: `tests/agent-validate.unit.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/agent-validate.unit.test.ts
import { describe, expect, it } from "vitest";

import { validateScript } from "@/lib/agents/validate";
import { getTemplate } from "@/lib/agents/templates";

const webinar = getTemplate("webinar")!;

describe("validateScript", () => {
  it("passes a fully-filled webinar with a name", () => {
    expect(validateScript("HireAI Sept", webinar.script)).toEqual([]);
  });

  it("flags a missing name", () => {
    const errs = validateScript("   ", webinar.script);
    expect(errs).toContain("Give the agent a name.");
  });

  it("flags a missing purpose and goal", () => {
    const errs = validateScript("X", {
      ...webinar.script,
      purpose: "",
      goal: "",
    });
    expect(errs).toContain("Add a purpose.");
    expect(errs).toContain("Add a goal.");
  });

  it("flags a required key detail left blank, by its label", () => {
    const keyDetails = webinar.script.keyDetails.map((d) =>
      d.id === "event_date" ? { ...d, value: "" } : d,
    );
    const errs = validateScript("X", { ...webinar.script, keyDetails });
    expect(errs).toContain('Fill in "Event date".');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/agent-validate.unit.test.ts`
Expected: FAIL — cannot resolve `@/lib/agents/validate`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/agents/validate.ts
import type { AgentScript } from "@/lib/agents/templates/types";

/** Plain-English reasons the agent can't be saved yet. Empty array = OK to save.
 *  This is the structural guarantee against shipping a blank/stale required
 *  fact (e.g. an empty event date). */
export function validateScript(name: string, script: AgentScript): string[] {
  const errors: string[] = [];
  if (!name.trim()) errors.push("Give the agent a name.");
  if (!script.purpose.trim()) errors.push("Add a purpose.");
  if (!script.goal.trim()) errors.push("Add a goal.");
  for (const d of script.keyDetails) {
    if (d.required && !d.value.trim()) errors.push(`Fill in "${d.label}".`);
  }
  return errors;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/agent-validate.unit.test.ts`
Expected: PASS (4 passing).

- [ ] **Step 5: Commit**

```bash
git add src/lib/agents/validate.ts tests/agent-validate.unit.test.ts
git commit -m "feat(agents): validateScript blocks save on blank required fields"
```

---

## Task 7: previewScript — deterministic "how the call sounds"

**Files:**

- Create: `src/lib/agents/preview.ts`
- Test: `tests/agent-preview.unit.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/agent-preview.unit.test.ts
import { describe, expect, it } from "vitest";

import { previewScript } from "@/lib/agents/preview";
import { getTemplate } from "@/lib/agents/templates";

const webinar = getTemplate("webinar")!;

describe("previewScript", () => {
  const p = previewScript(webinar.script);

  it("fills sample values into the opening (no raw placeholders)", () => {
    expect(p.opening).toContain("Jamie");
    expect(p.opening).not.toContain("[name]");
    expect(p.opening).not.toContain("[industry]");
    expect(p.opening.length).toBeGreaterThan(0);
  });

  it("lists the specifics with the date formatted", () => {
    const dateLine = p.specifics.find((s) => s.label === "Event date");
    expect(dateLine?.value).toContain("August 27, 2026");
  });

  it("handles an empty script without throwing", () => {
    const blank = getTemplate("blank")!;
    const r = previewScript(blank.script);
    expect(r.opening).toBe("");
    expect(r.specifics).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/agent-preview.unit.test.ts`
Expected: FAIL — cannot resolve `@/lib/agents/preview`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/agents/preview.ts
import type { AgentScript, KeyDetail } from "@/lib/agents/templates/types";

/** Representative lead values so a non-techy user sees a real-sounding opening
 *  instead of raw placeholders. Mirrors the sample context the campaign Test
 *  call tab uses. */
const SAMPLE: Record<string, string> = {
  "[name]": "Jamie",
  "[industry]": "gym",
  "{{business_name}}": "Jamie's Gym",
  "{{owner_name}}": "Jamie",
};

function fillSample(text: string): string {
  let out = text;
  for (const [token, value] of Object.entries(SAMPLE)) {
    out = out.split(token).join(value);
  }
  return out;
}

function formatDetail(d: KeyDetail): string {
  if (d.type === "date" && /^\d{4}-\d{2}-\d{2}$/.test(d.value)) {
    const parsed = new Date(`${d.value}T00:00:00`);
    if (!Number.isNaN(parsed.getTime())) {
      return new Intl.DateTimeFormat("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      }).format(parsed);
    }
  }
  return d.value;
}

export type ScriptPreview = {
  opening: string;
  specifics: { label: string; value: string }[];
};

/** Deterministic preview: the first line or two of the script with sample lead
 *  values filled in, plus the specifics the agent will rely on. No AI. */
export function previewScript(script: AgentScript): ScriptPreview {
  const firstChunk =
    script.scriptProse
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)[0] ?? "";
  return {
    opening: firstChunk ? fillSample(firstChunk) : "",
    specifics: script.keyDetails
      .filter((d) => d.value.trim())
      .map((d) => ({ label: d.label, value: formatDetail(d) })),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/agent-preview.unit.test.ts`
Expected: PASS (3 passing).

- [ ] **Step 5: Commit**

```bash
git add src/lib/agents/preview.ts tests/agent-preview.unit.test.ts
git commit -m "feat(agents): deterministic script preview (sample-filled opening + specifics)"
```

---

## Task 8: DB migration — template columns on agents

**Files:**

- Create: `supabase/migrations/20260814120000_agent_template_columns.sql`
- Modify (generated): `src/lib/supabase/database.types.ts`

- [ ] **Step 1: Write the migration**

```sql
-- Template-based agent builder (Phase 1). Adds the "script layer" columns.
-- The locked instructions are snapshotted onto the agent at creation so editing
-- a template later never silently changes live agents.
alter table public.agents
  add column if not exists template_key text,
  add column if not exists instructions text,
  add column if not exists prompt_purpose text,
  add column if not exists key_details jsonb not null default '[]'::jsonb,
  add column if not exists script_prose text;

comment on column public.agents.template_key is
  'Which starting template this agent was built from (webinar, blank, …). Null for legacy wizard-built agents.';
comment on column public.agents.instructions is
  'Snapshot of the locked behavioral instructions at creation time.';
comment on column public.agents.key_details is
  'Editable typed facts the agent uses: [{id,label,type,value,required}].';
```

- [ ] **Step 2: Apply to the linked prod DB**

Run: `env -u SUPABASE_ACCESS_TOKEN supabase db push --linked`
Expected: reports the new migration applied. (Additive `add column if not exists` — safe on the live table.)

- [ ] **Step 3: Regenerate DB types**

Run: `env -u SUPABASE_ACCESS_TOKEN supabase gen types typescript --linked --schema public > src/lib/supabase/database.types.ts`
Expected: `agents` Row/Insert/Update now include `template_key`, `instructions`, `prompt_purpose`, `key_details`, `script_prose`.

- [ ] **Step 4: Verify the app still type-checks**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260814120000_agent_template_columns.sql src/lib/supabase/database.types.ts
git commit -m "feat(db): add template/script columns to agents"
```

---

## Task 9: Server actions — createAgentFromTemplate + updateAgentScript

**Files:**

- Modify: `src/lib/agents/actions.ts` (add two exports; reuse `syncAgentToElevenLabs`, `normalizeDataCollection`)

- [ ] **Step 1: Add the create action**

Append to `src/lib/agents/actions.ts` (imports: add `assembleFromScript` from `@/lib/agents/assemble`, `getTemplate` + `normalizeKeyDetails` + types from `@/lib/agents/templates`):

```ts
import { assembleFromScript } from "@/lib/agents/assemble";
import {
  getTemplate,
  normalizeKeyDetails,
  type AgentScript,
} from "@/lib/agents/templates";

const AGENT_MODEL = "gpt-5.4";

export type TemplateAgentInput = {
  templateKey: string;
  name: string;
  voiceId: string;
  script: AgentScript;
  toolsEnabled: ToolsEnabled;
  knowledgeBaseIds: string[];
};

/** Create an agent from a template's locked instructions + the edited script.
 *  Mirrors createAgent's insert-then-sync-then-rollback shape. */
export async function createAgentFromTemplate(
  input: TemplateAgentInput,
): Promise<AgentResult> {
  const name = input.name.trim();
  if (!name) return { error: "Give the agent a name." };

  const template = getTemplate(input.templateKey);
  if (!template) return { error: "Unknown template." };

  const script: AgentScript = {
    purpose: input.script.purpose ?? "",
    goal: input.script.goal ?? "",
    keyDetails: normalizeKeyDetails(input.script.keyDetails),
    scriptProse: input.script.scriptProse ?? "",
    dataCollection: normalizeDataCollection(input.script.dataCollection),
  };

  const systemPrompt = assembleFromScript({
    instructions: template.instructions,
    script,
    toolsEnabled: input.toolsEnabled,
  });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { data: created, error } = await supabase
    .from("agents")
    .insert({
      owner_id: user.id,
      name,
      voice_id: input.voiceId.trim() || null,
      ai_model: AGENT_MODEL,
      system_prompt: systemPrompt,
      template_key: template.key,
      instructions: template.instructions,
      prompt_purpose: script.purpose || null,
      prompt_goal: script.goal || null,
      key_details: script.keyDetails as unknown as Json,
      script_prose: script.scriptProse || null,
      tools_enabled: input.toolsEnabled,
      knowledge_base_ids: input.knowledgeBaseIds,
      extra_data_collection: script.dataCollection as unknown as Json,
      extra_evaluation: [] as unknown as Json,
    })
    .select("id")
    .single();
  if (error || !created) return { error: "Could not save the agent." };

  const sync = await syncAgentToElevenLabs(
    {
      name,
      systemPrompt,
      voiceId: input.voiceId.trim() || null,
      aiModel: AGENT_MODEL,
      goal: script.goal || null,
      extraDataCollection: script.dataCollection,
      extraEvaluation: [],
      toolsEnabled: input.toolsEnabled,
    },
    null,
  );
  if (sync.error) {
    await supabase.from("agents").delete().eq("id", created.id);
    return { error: sync.error };
  }
  if (sync.elevenlabsAgentId) {
    await supabase
      .from("agents")
      .update({ elevenlabs_agent_id: sync.elevenlabsAgentId })
      .eq("id", created.id);
  }

  revalidatePath("/settings/agents");
  return { error: null, agentId: created.id };
}
```

- [ ] **Step 2: Add the update action** (instructions stay locked — re-use the stored snapshot)

```ts
/** Update a template-made agent's SCRIPT (never its locked instructions) and
 *  re-sync. The instructions come from the agent's stored snapshot. */
export async function updateAgentScript(
  id: string,
  input: Omit<TemplateAgentInput, "templateKey">,
): Promise<AgentResult> {
  const name = input.name.trim();
  if (!name) return { error: "Give the agent a name." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { data: existing } = await supabase
    .from("agents")
    .select("elevenlabs_agent_id, instructions")
    .eq("id", id)
    .maybeSingle();
  if (!existing) return { error: "That agent no longer exists." };

  const script: AgentScript = {
    purpose: input.script.purpose ?? "",
    goal: input.script.goal ?? "",
    keyDetails: normalizeKeyDetails(input.script.keyDetails),
    scriptProse: input.script.scriptProse ?? "",
    dataCollection: normalizeDataCollection(input.script.dataCollection),
  };

  const systemPrompt = assembleFromScript({
    instructions: existing.instructions ?? "",
    script,
    toolsEnabled: input.toolsEnabled,
  });

  const { error } = await supabase
    .from("agents")
    .update({
      name,
      voice_id: input.voiceId.trim() || null,
      system_prompt: systemPrompt,
      prompt_purpose: script.purpose || null,
      prompt_goal: script.goal || null,
      key_details: script.keyDetails as unknown as Json,
      script_prose: script.scriptProse || null,
      tools_enabled: input.toolsEnabled,
      knowledge_base_ids: input.knowledgeBaseIds,
      extra_data_collection: script.dataCollection as unknown as Json,
    })
    .eq("id", id);
  if (error) return { error: "Could not update the agent." };

  const sync = await syncAgentToElevenLabs(
    {
      name,
      systemPrompt,
      voiceId: input.voiceId.trim() || null,
      aiModel: AGENT_MODEL,
      goal: script.goal || null,
      extraDataCollection: script.dataCollection,
      extraEvaluation: [],
      toolsEnabled: input.toolsEnabled,
    },
    existing.elevenlabs_agent_id,
  );
  if (sync.error) return { error: sync.error };
  if (
    sync.elevenlabsAgentId &&
    sync.elevenlabsAgentId !== existing.elevenlabs_agent_id
  ) {
    await supabase
      .from("agents")
      .update({ elevenlabs_agent_id: sync.elevenlabsAgentId })
      .eq("id", id);
  }

  revalidatePath("/settings/agents");
  return { error: null, agentId: id };
}
```

> NOTE: `AGENT_MODEL` may already be implicitly defined elsewhere in the wizard; here it is declared once in `actions.ts`. If a duplicate `const AGENT_MODEL` lint error appears, keep this one and remove the redundant local. Confirm `syncAgentToElevenLabs`'s `AgentSyncPayload` accepts `extraEvaluation` as an array (it does — see `src/lib/elevenlabs/agents.ts:31`).

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/agents/actions.ts
git commit -m "feat(agents): createAgentFromTemplate + updateAgentScript server actions"
```

---

## Task 10: Template gallery (front door) + route wiring

**Files:**

- Create: `src/app/(app)/settings/agents/template-gallery.tsx`
- Rewrite: `src/app/(app)/settings/agents/new/page.tsx`
- Create: `src/app/(app)/settings/agents/new/scratch/page.tsx`

- [ ] **Step 1: Build the gallery component** (server component; cards + Advanced link)

```tsx
// src/app/(app)/settings/agents/template-gallery.tsx
import Link from "next/link";
import { ArrowRight, PencilRuler } from "lucide-react";

import { Breadcrumbs } from "@/components/app-shell/breadcrumbs";
import { AGENT_TEMPLATES } from "@/lib/agents/templates";

export function TemplateGallery() {
  return (
    <div className="flex flex-col gap-5 p-6">
      <Breadcrumbs
        items={[
          { label: "Settings", href: "/settings/overview" },
          { label: "Agents", href: "/settings/agents" },
          { label: "New agent" },
        ]}
      />
      <div>
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          Build agent
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Start from a proven template — the behavior's already dialed in, you
          just write the script.
        </p>
      </div>

      <div className="grid max-w-3xl gap-3 sm:grid-cols-2">
        {AGENT_TEMPLATES.map((t) => (
          <Link
            key={t.key}
            href={`/settings/agents/new/${t.key}`}
            className="border-border hover:border-border-strong hover:bg-muted/30 group flex flex-col gap-1 rounded-2xl border p-5 transition-colors"
          >
            <span className="text-foreground flex items-center justify-between text-sm font-semibold">
              {t.name}
              <ArrowRight className="text-muted-foreground size-4 transition-transform group-hover:translate-x-0.5" />
            </span>
            <span className="text-muted-foreground text-xs">
              {t.description}
            </span>
          </Link>
        ))}
      </div>

      <Link
        href="/settings/agents/new/scratch"
        className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1.5 text-xs"
      >
        <PencilRuler className="size-3.5" />
        Advanced — build from scratch
      </Link>
    </div>
  );
}
```

- [ ] **Step 2: Repurpose `new/page.tsx` to render the gallery**

```tsx
// src/app/(app)/settings/agents/new/page.tsx
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

import { TemplateGallery } from "../template-gallery";

export default async function NewAgentPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return <TemplateGallery />;
}
```

- [ ] **Step 3: Move the old wizard to `new/scratch/page.tsx`** (copy of the pre-change `new/page.tsx` body)

```tsx
// src/app/(app)/settings/agents/new/scratch/page.tsx
import { redirect } from "next/navigation";

import { FIXED_VOICES } from "@/lib/elevenlabs/voices";
import { createClient } from "@/lib/supabase/server";

import { AgentWizard } from "../../agent-wizard";

export default async function ScratchAgentPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: kbs } = await supabase
    .from("knowledge_bases")
    .select("id, name")
    .order("name");
  const knowledgeBases = (kbs ?? []).map((k) => ({ id: k.id, name: k.name }));

  return <AgentWizard voices={FIXED_VOICES} knowledgeBases={knowledgeBases} />;
}
```

- [ ] **Step 4: Verify build**

Run: `npx tsc --noEmit && npm run build`
Expected: build succeeds; `/settings/agents/new` and `/settings/agents/new/scratch` compile.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/settings/agents/template-gallery.tsx" "src/app/(app)/settings/agents/new/page.tsx" "src/app/(app)/settings/agents/new/scratch/page.tsx"
git commit -m "feat(agents): template gallery front door + advanced (scratch) route"
```

---

## Task 11: The one-screen builder component

**Files:**

- Create: `src/app/(app)/settings/agents/agent-builder.tsx`

This is the create/edit client component. It renders: Name + Voice, the locked Instructions card, the editable Script (Purpose, Goal, Key details, Script prose, Data collection), a collapsed Advanced (tools read-only), the live preview, and save (blocked by `validateScript`). Reuse the same UI primitives the wizard uses (`Card`, `Input`, `Label`, `Textarea`, `Select`, `Button`, `Checkbox`, `sonner` toast, `Breadcrumbs`).

- [ ] **Step 1: Write the component**

```tsx
// src/app/(app)/settings/agents/agent-builder.tsx
"use client";

import { ArrowLeft, Lock, Plus, Save, Sparkles, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

import { Breadcrumbs } from "@/components/app-shell/breadcrumbs";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  createAgentFromTemplate,
  updateAgentScript,
} from "@/lib/agents/actions";
import {
  toFieldId,
  type ExtraDataCollectionField,
} from "@/lib/agents/data-collection";
import { previewScript } from "@/lib/agents/preview";
import type {
  AgentScript,
  AgentTemplate,
  KeyDetail,
} from "@/lib/agents/templates";
import { validateScript } from "@/lib/agents/validate";
import type { FixedVoice } from "@/lib/elevenlabs/voices";
import { TOOL_LABELS, type ToolsEnabled } from "@/lib/agents/prompt";

export type BuilderAgent = {
  id: string;
  name: string;
  voiceId: string;
  templateKey: string;
  instructions: string;
  tools: ToolsEnabled;
  knowledgeBaseIds: string[];
  script: AgentScript;
};

export function AgentBuilder({
  template,
  voices,
  agent,
}: {
  template: AgentTemplate;
  voices: FixedVoice[];
  agent?: BuilderAgent;
}) {
  const router = useRouter();
  const isEdit = Boolean(agent);
  const [name, setName] = useState(agent?.name ?? "");
  const [voiceId, setVoiceId] = useState(
    agent?.voiceId || template.defaultVoiceId || voices[0]?.id || "",
  );
  const tools = agent?.tools ?? template.tools; // fixed in Phase 1 (read-only)
  const [purpose, setPurpose] = useState(
    agent?.script.purpose ?? template.script.purpose,
  );
  const [goal, setGoal] = useState(agent?.script.goal ?? template.script.goal);
  const [keyDetails, setKeyDetails] = useState<KeyDetail[]>(
    agent?.script.keyDetails ?? template.script.keyDetails,
  );
  const [scriptProse, setScriptProse] = useState(
    agent?.script.scriptProse ?? template.script.scriptProse,
  );
  const [dataCollection, setDataCollection] = useState<
    ExtraDataCollectionField[]
  >(agent?.script.dataCollection ?? template.script.dataCollection);
  const [pending, startTransition] = useTransition();

  const script: AgentScript = {
    purpose,
    goal,
    keyDetails,
    scriptProse,
    dataCollection,
  };
  const errors = validateScript(name, script);
  const preview = useMemo(() => previewScript(script), [script]);

  function setDetail(i: number, patch: Partial<KeyDetail>) {
    setKeyDetails((ds) =>
      ds.map((d, idx) => (idx === i ? { ...d, ...patch } : d)),
    );
  }

  function save() {
    if (errors.length > 0) {
      toast.error(errors[0]);
      return;
    }
    startTransition(async () => {
      const payload = {
        name,
        voiceId,
        script,
        toolsEnabled: tools,
        knowledgeBaseIds: agent?.knowledgeBaseIds ?? [],
      };
      const result = agent
        ? await updateAgentScript(agent.id, payload)
        : await createAgentFromTemplate({
            templateKey: template.key,
            ...payload,
          });
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(isEdit ? "Agent updated." : "Agent created.");
        router.push("/settings/agents");
      }
    });
  }

  return (
    <div className="flex flex-col gap-5 p-6">
      <Breadcrumbs
        items={[
          { label: "Settings", href: "/settings/overview" },
          { label: "Agents", href: "/settings/agents" },
          { label: isEdit ? "Edit agent" : template.name },
        ]}
      />
      <div>
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          {isEdit ? "Edit agent" : "Build agent"}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {isEdit
            ? "Editing the script — behavior stays locked."
            : `From the ${template.name} template`}
        </p>
      </div>

      <div className="grid max-w-5xl gap-5 lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-4">
          {/* Basics */}
          <Card className="rounded-2xl">
            <CardContent className="flex flex-col gap-4 pt-6">
              <div className="flex flex-col gap-2">
                <Label htmlFor="agent-name">Agent name</Label>
                <Input
                  id="agent-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. HireAI Webinar — September"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="agent-voice">Voice</Label>
                <Select value={voiceId} onValueChange={setVoiceId}>
                  <SelectTrigger id="agent-voice">
                    <SelectValue placeholder="Choose a voice" />
                  </SelectTrigger>
                  <SelectContent>
                    {voices.map((v) => (
                      <SelectItem key={v.id} value={v.id}>
                        {v.name} · {v.gender === "female" ? "Female" : "Male"} ·{" "}
                        {v.vibe}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          {/* Locked instructions */}
          <Card className="bg-muted/20 rounded-2xl">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Lock className="size-4" /> Instructions — how the agent behaves
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground text-xs">
                Locked, proven behavior — turn-taking, human delivery,
                gatekeeper handling, do-not-call, voicemail/IVR. You can&apos;t
                break it, and don&apos;t need to.
              </p>
            </CardContent>
          </Card>

          {/* Editable script */}
          <Card className="rounded-2xl">
            <CardHeader>
              <CardTitle className="text-sm">
                Script — what it says &amp; what it&apos;s for
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="agent-purpose">Purpose</Label>
                <Input
                  id="agent-purpose"
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="agent-goal">
                  Goal — what counts as success
                </Label>
                <Input
                  id="agent-goal"
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                />
              </div>

              {/* Key details */}
              <div className="flex flex-col gap-2">
                <Label>Key details</Label>
                {keyDetails.map((d, i) => (
                  <div key={d.id} className="flex items-center gap-2">
                    <span className="text-muted-foreground w-32 shrink-0 text-xs">
                      {d.label}
                    </span>
                    <Input
                      aria-label={d.label}
                      type={d.type === "date" ? "date" : "text"}
                      value={d.value}
                      onChange={(e) => setDetail(i, { value: e.target.value })}
                    />
                  </div>
                ))}
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="agent-script">The script</Label>
                <Textarea
                  id="agent-script"
                  value={scriptProse}
                  onChange={(e) => setScriptProse(e.target.value)}
                  rows={12}
                />
              </div>

              {/* Data collection — plain English */}
              <DataCollectionEditor
                value={dataCollection}
                onChange={setDataCollection}
              />
            </CardContent>
          </Card>

          <div className="flex items-center justify-between">
            <Button
              variant="ghost"
              onClick={() => router.back()}
              disabled={pending}
            >
              <ArrowLeft className="size-4" /> Back
            </Button>
            <Button onClick={save} disabled={pending || errors.length > 0}>
              {pending ? (
                <Sparkles className="size-4 animate-pulse" />
              ) : (
                <Save className="size-4" />
              )}
              {pending ? "Saving…" : isEdit ? "Save changes" : "Save agent"}
            </Button>
          </div>
          {errors.length > 0 ? (
            <p className="text-muted-foreground text-xs">
              Before saving: {errors[0]}
            </p>
          ) : null}
        </div>

        {/* Live preview */}
        <aside className="flex flex-col gap-3">
          <Card className="rounded-2xl">
            <CardHeader>
              <CardTitle className="text-sm">How the call will sound</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p
                className="text-foreground text-sm"
                data-testid="preview-opening"
              >
                {preview.opening || "Write a script to see the opening here."}
              </p>
              {preview.specifics.length > 0 ? (
                <ul className="text-muted-foreground flex flex-col gap-1 text-xs">
                  {preview.specifics.map((s) => (
                    <li key={s.label}>
                      <span className="font-medium">{s.label}:</span> {s.value}
                    </li>
                  ))}
                </ul>
              ) : null}
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}

/** Plain-English data collection rows (no field_name/enum jargon). The machine
 *  id is derived from the label via toFieldId under the hood. */
function DataCollectionEditor({
  value,
  onChange,
}: {
  value: ExtraDataCollectionField[];
  onChange: (v: ExtraDataCollectionField[]) => void;
}) {
  function add() {
    onChange([
      ...value,
      { id: "", type: "boolean", description: "", enumValues: [] },
    ]);
  }
  function update(i: number, label: string) {
    onChange(
      value.map((f, idx) =>
        idx === i ? { ...f, id: toFieldId(label), description: label } : f,
      ),
    );
  }
  function remove(i: number) {
    onChange(value.filter((_, idx) => idx !== i));
  }
  return (
    <div className="flex flex-col gap-2">
      <Label>What should the agent find out on each call?</Label>
      {value.map((f, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            aria-label="What to find out"
            value={f.description}
            onChange={(e) => update(i, e.target.value)}
            placeholder="e.g. Are they the decision-maker?"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Remove"
            onClick={() => remove(i)}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={add}
        className="w-fit"
      >
        <Plus className="size-4" /> Add
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: Type-check + build**

Run: `npx tsc --noEmit && npm run build`
Expected: succeeds. (If `TOOL_LABELS` import is unused after trimming, remove it to satisfy eslint.)

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/settings/agents/agent-builder.tsx"
git commit -m "feat(agents): one-screen template builder (locked instructions + editable script + live preview)"
```

---

## Task 12: Builder route + edit-page branching

**Files:**

- Create: `src/app/(app)/settings/agents/new/[template]/page.tsx`
- Modify: `src/app/(app)/settings/agents/[id]/edit/page.tsx`

- [ ] **Step 1: Create the builder route** (loads a template by key)

```tsx
// src/app/(app)/settings/agents/new/[template]/page.tsx
import { notFound, redirect } from "next/navigation";

import { FIXED_VOICES } from "@/lib/elevenlabs/voices";
import { getTemplate } from "@/lib/agents/templates";
import { createClient } from "@/lib/supabase/server";

import { AgentBuilder } from "../../agent-builder";

export default async function NewFromTemplatePage({
  params,
}: {
  params: Promise<{ template: string }>;
}) {
  const { template: key } = await params;
  const template = getTemplate(key);
  if (!template) notFound();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return <AgentBuilder template={template} voices={FIXED_VOICES} />;
}
```

- [ ] **Step 2: Branch the edit page** — template-made agents use the builder; legacy agents keep the wizard. Read the current `[id]/edit/page.tsx` first, then adapt its data-loading to also select the new columns and choose the component:

```tsx
// src/app/(app)/settings/agents/[id]/edit/page.tsx  (key changes)
import { getTemplate, normalizeKeyDetails } from "@/lib/agents/templates";
import { normalizeDataCollection } from "@/lib/agents/data-collection";
import { AgentBuilder, type BuilderAgent } from "../../agent-builder";
// … keep existing imports for AgentWizard, FIXED_VOICES, createClient, redirect …

export default async function EditAgentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: agent } = await supabase
    .from("agents")
    .select(
      "id, name, voice_id, template_key, instructions, prompt_purpose, prompt_goal, key_details, script_prose, tools_enabled, knowledge_base_ids, extra_data_collection, externally_managed, system_prompt, prompt_personality, prompt_environment, prompt_tone, prompt_guardrails, ai_model, extra_evaluation",
    )
    .eq("id", id)
    .maybeSingle();
  if (!agent) redirect("/settings/agents");

  // Template-made agents → the new one-screen builder.
  const template = agent.template_key
    ? getTemplate(agent.template_key)
    : undefined;
  if (template && !agent.externally_managed) {
    const builderAgent: BuilderAgent = {
      id: agent.id,
      name: agent.name,
      voiceId: agent.voice_id ?? "",
      templateKey: agent.template_key!,
      instructions: agent.instructions ?? template.instructions,
      tools: (agent.tools_enabled ?? {}) as Record<string, boolean>,
      knowledgeBaseIds: (agent.knowledge_base_ids ?? []) as string[],
      script: {
        purpose: agent.prompt_purpose ?? "",
        goal: agent.prompt_goal ?? "",
        keyDetails: normalizeKeyDetails(agent.key_details),
        scriptProse: agent.script_prose ?? "",
        dataCollection: normalizeDataCollection(agent.extra_data_collection),
      },
    };
    return (
      <AgentBuilder
        template={template}
        voices={FIXED_VOICES}
        agent={builderAgent}
      />
    );
  }

  // Legacy wizard-built (or connected) agents → keep the old wizard exactly as before.
  // … existing AgentWizard render path, unchanged (map agent → AgentInitial) …
}
```

> When implementing Step 2, open the existing `[id]/edit/page.tsx`, KEEP its current `AgentWizard` mapping as the fallback branch, and only ADD the `template`-branch above it. Do not delete the wizard path — connected and legacy agents still need it.

- [ ] **Step 3: Build**

Run: `npx tsc --noEmit && npm run build`
Expected: succeeds; `/settings/agents/new/webinar`, `/settings/agents/new/blank`, and edit routes compile.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/settings/agents/new/[template]/page.tsx" "src/app/(app)/settings/agents/[id]/edit/page.tsx"
git commit -m "feat(agents): builder route + edit branches to builder for template agents"
```

---

## Task 13: Rewrite the Playwright e2e for the new flow

**Files:**

- Rewrite: `tests/agents.spec.ts`

- [ ] **Step 1: Replace the wizard tests with template-flow tests**

```ts
// tests/agents.spec.ts
import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });
test.describe.configure({ mode: "serial" });

test.describe("Agent template builder", () => {
  const stamp = Date.now();
  const agentName = `E2E Agent ${stamp}`;
  let admin: SupabaseClient;

  test.beforeAll(async () => {
    admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    await admin.from("agents").delete().like("name", "E2E Agent %");
  });

  test.afterAll(async () => {
    await admin.from("agents").delete().like("name", "E2E Agent %");
  });

  test("gallery → webinar template → edit script → save", async ({ page }) => {
    await page.goto("/settings/agents/new");

    // Gallery front door.
    await expect(
      page.getByRole("heading", { name: "Build agent" }),
    ).toBeVisible();
    await page.getByRole("link", { name: /Webinar invite/ }).click();
    await expect(page).toHaveURL(/\/new\/webinar$/);

    // The webinar script is pre-filled; the live preview shows the opening.
    await expect(page.getByTestId("preview-opening")).toContainText("Jamie");

    // Fill the name and change the event date (the anti-landmine field).
    await page.getByLabel("Agent name").fill(agentName);
    await page.getByLabel("Event date", { exact: true }).fill("2026-09-24");

    await page.getByRole("button", { name: "Save agent" }).click();
    await expect(page).toHaveURL(/\/settings\/agents$/);

    // DB shape: template snapshot + assembled prompt with the date injected ONCE.
    const { data: agent } = await admin
      .from("agents")
      .select(
        "name, template_key, instructions, key_details, system_prompt, elevenlabs_agent_id",
      )
      .eq("name", agentName)
      .single();
    expect(agent?.template_key).toBe("webinar");
    expect(agent?.instructions).toContain("exactly ONE question");
    expect(agent?.system_prompt).toContain("September 24, 2026");
    expect(agent?.elevenlabs_agent_id).toMatch(/^agent_mock_/);
    const details = agent?.key_details as { id: string; value: string }[];
    expect(details.find((d) => d.id === "event_date")?.value).toBe(
      "2026-09-24",
    );
  });

  test("save is blocked until the name is filled", async ({ page }) => {
    await page.goto("/settings/agents/new/webinar");
    // Name starts empty → Save disabled.
    await expect(
      page.getByRole("button", { name: "Save agent" }),
    ).toBeDisabled();
    await page.getByLabel("Agent name").fill(`E2E Agent block ${Date.now()}`);
    await expect(
      page.getByRole("button", { name: "Save agent" }),
    ).toBeEnabled();
  });

  test("the old wizard still lives behind Advanced", async ({ page }) => {
    await page.goto("/settings/agents/new");
    await page
      .getByRole("link", { name: /Advanced — build from scratch/ })
      .click();
    await expect(page).toHaveURL(/\/new\/scratch$/);
    await expect(
      page.getByRole("heading", { name: "Build agent" }),
    ).toBeVisible();
    await expect(page.getByLabel("Name", { exact: true })).toBeVisible();
  });
});
```

- [ ] **Step 2: Run the e2e** (requires the dev server / Playwright setup the repo already uses)

Run: `npx playwright test tests/agents.spec.ts`
Expected: 3 passing. (If the ElevenLabs mock env isn't set locally, the sync returns a mock `agent_mock_` id — matching the assertion. If Playwright auth/storage isn't configured in this environment, note it and rely on the vitest suite + `npm run build` as the gate, per the repo's CI history.)

- [ ] **Step 3: Commit**

```bash
git add tests/agents.spec.ts
git commit -m "test(agents): e2e for template gallery + builder + advanced escape hatch"
```

---

## Task 14: Full verification sweep

- [ ] **Step 1: Unit tests**

Run: `npm run test:unit`
Expected: all suites pass, including the four new `agent-*.unit.test.ts`.

- [ ] **Step 2: Types + lint + build**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: clean.

- [ ] **Step 3: Manual smoke (dev server)**

Run: `npm run dev`, then:

- Visit `/settings/agents/new` → see Webinar + Blank cards + Advanced link.
- Open Webinar → preview shows an opening with "Jamie"; change the Event date → preview + (after save) the prompt reflect it.
- Save → lands on `/settings/agents`, the agent shows "Synced".
- Edit that agent → the builder reopens (not the wizard), instructions card is read-only, script is editable.
- Open an OLD agent's edit → the 10-step wizard still loads.

- [ ] **Step 4: Commit any fixes, then open a PR**

```bash
git push -u origin feat/agent-template-builder
gh pr create --title "Agent template builder (Phase 1)" --body "Replaces the 10-step wizard with a template-based one-screen builder. Spec: docs/superpowers/specs/2026-08-14-agent-template-builder-design.md"
```

---

## Self-Review notes (for the executor)

- **Spec coverage:** one-screen builder (T11), locked instructions per-template snapshot (T3, T9), generalized typed Key details incl. date-landmine fix (T1, T5 test asserts the date appears once), data collection promoted + plain-English (T11 `DataCollectionEditor`), tools fixed (T11 uses `template.tools`, read-only), success rules from Goal (T9 passes `goal` to sync → base "goal" criterion), gallery front door + Advanced (T10), edit uses new screen (T12), live preview (T7, T11), validation (T6, T11), Webinar+Blank seeds (T3). Knowledge base is intentionally NOT surfaced in the builder for Phase 1 (spec: folded into Advanced); it remains available via the scratch wizard — acceptable for Phase 1.
- **Out of scope confirmed:** no "Save as template", no AI tidy, no agent-RLS change (admin-only ships now; teammate access via `project_teammate_onboarding`).
- **Type consistency:** `AgentScript`, `KeyDetail`, `AgentTemplate` defined in T1; `assembleFromScript` (T5) and `validateScript` (T6) and `previewScript` (T7) all consume `AgentScript`; actions (T9) and builder (T11) use the same shapes.
