# Save as Template (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin turn any proven agent (including an imported ElevenLabs one) into a reusable, shared template — via an AI-proposed instructions/script split the admin corrects in the existing builder — plus edit/delete templates and a "tidy wording" helper.

**Architecture:** A new `agent_templates` table holds admin-curated templates; the gallery unions the code seeds (Blank, Webinar) with these DB rows. An AI module splits an agent's prompt text into the Phase-1 `AgentTemplate` shape (locked Instructions + editable Script + typed Key details), with a deterministic fallback. The Phase-1 `AgentBuilder` gains a `mode: "template"` that pre-fills from the split, makes Instructions editable, and saves to `agent_templates`. All create/edit/delete paths are admin-gated in the UI **and** by RLS.

**Tech Stack:** Next.js 16 App Router, Supabase (Postgres + RLS), OpenAI (via `openAiKey()`), ElevenLabs prompt fetch (`fetchElevenLabsAgentPrompt`), vitest, Playwright. Path alias `@/` → `src/`.

**Builds on:** Phase 1 (merged) — `src/lib/agents/templates/*`, `assemble.ts`, `validate.ts`, `preview.ts`, `agent-builder.tsx`, the gallery, and the `agents` script columns all already exist.
**Spec:** `docs/superpowers/specs/2026-08-15-agent-save-as-template-design.md`.

---

## File Structure

**New — logic (`src/lib/`):**

- `agents/templates/from-row.ts` — `templateFromRow()` + `scriptFromJson()` (DB row → Phase-1 `AgentTemplate`).
- `agents/templates/resolve.ts` — `resolveTemplate(key, supabase)` (code registry first, else DB by id).
- `ai/split-agent-template.ts` — `splitAgentIntoTemplate()` + pure `parseSplitResponse()`.
- `ai/tidy-prose.ts` — `tidyProse()`.
- `agents/template-actions.ts` — server actions: `saveTemplate`, `updateTemplate`, `deleteTemplate`, and server helper `buildTemplateDraftFromAgent()`.

**New — DB:**

- `supabase/migrations/20260815120000_agent_templates.sql`.

**New/Modified — UI (`src/app/(app)/settings/agents/`):**

- `agent-builder.tsx` — **modified**: add `mode: "agent" | "template"`, template Name/Description, editable Instructions, save-to-template.
- `templates/new/page.tsx` — **new**: `?from=<agentId>` → build draft via split → builder (template mode).
- `templates/[id]/edit/page.tsx` — **new**: load DB template → builder (template mode, edit).
- `template-gallery.tsx` — **modified**: render DB template cards + admin edit/delete affordances.
- `new/page.tsx` — **modified**: fetch DB templates + `isAdmin`, pass to gallery.
- `delete-template-button.tsx` — **new**: client button calling `deleteTemplate`.
- `page.tsx` (agents list) — **modified**: admin-only per-row "Save as template" link.

**New/Modified — tests:**

- `tests/agent-template-from-row.unit.test.ts`, `tests/agent-template-resolve.unit.test.ts`, `tests/split-agent-template.unit.test.ts`, `tests/tidy-prose.unit.test.ts` — new vitest.
- `tests/agent-templates-save.spec.ts` — new Playwright (contract).

---

## Task 1: Migration — agent_templates table

**Files:**

- Create: `supabase/migrations/20260815120000_agent_templates.sql`
- Modify (generated): `src/lib/supabase/database.types.ts`

- [ ] **Step 1: Write the migration**

```sql
-- Admin-curated shared agent templates (Phase 2, "save as template" flywheel).
-- Everyone reads (shared shelf); only admins write. Consumed alongside the
-- code-seeded templates (Blank, Webinar).
create table public.agent_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  instructions text not null,
  default_voice_id text,
  tools jsonb not null default '{}'::jsonb,
  script jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.agent_templates is
  'Admin-curated shared agent templates: locked instructions + editable script skeleton.';
comment on column public.agent_templates.script is
  '{purpose, goal, keyDetails:[{id,label,type,value,required}], scriptProse, dataCollection}';

create trigger agent_templates_set_updated_at
  before update on public.agent_templates
  for each row execute function public.set_updated_at();

alter table public.agent_templates enable row level security;

create policy "agent_templates_select"
  on public.agent_templates for select to authenticated
  using (true);

create policy "agent_templates_write"
  on public.agent_templates for all to authenticated
  using (public.is_admin((select auth.uid())))
  with check (public.is_admin((select auth.uid())));
```

- [ ] **Step 2: Apply to prod**

Run: `env -u SUPABASE_ACCESS_TOKEN supabase db push --linked --yes`
Expected: applies `20260815120000_agent_templates.sql`. (New table, no impact on existing tables.)

- [ ] **Step 3: Regenerate types**

Run: `env -u SUPABASE_ACCESS_TOKEN supabase gen types typescript --linked --schema public > src/lib/supabase/database.types.ts`
Then: `npx prettier --write src/lib/supabase/database.types.ts`
Expected: an `agent_templates` block appears in the generated types (verify with `grep -n "agent_templates" src/lib/supabase/database.types.ts`).

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260815120000_agent_templates.sql src/lib/supabase/database.types.ts
git commit -m "feat(db): agent_templates table (shared shelf, admin-write RLS)"
```

---

## Task 2: DB row → AgentTemplate mapping

**Files:**

- Create: `src/lib/agents/templates/from-row.ts`
- Test: `tests/agent-template-from-row.unit.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/agent-template-from-row.unit.test.ts
import { describe, expect, it } from "vitest";

import {
  templateFromRow,
  scriptFromJson,
} from "@/lib/agents/templates/from-row";

describe("scriptFromJson", () => {
  it("tolerates junk and returns an empty script", () => {
    expect(scriptFromJson(null)).toEqual({
      purpose: "",
      goal: "",
      keyDetails: [],
      scriptProse: "",
      dataCollection: [],
    });
  });

  it("reads a well-formed script and normalizes key details", () => {
    const s = scriptFromJson({
      purpose: "P",
      goal: "G",
      scriptProse: "S",
      keyDetails: [
        {
          label: "Event date",
          type: "date",
          value: "2026-09-24",
          required: true,
        },
      ],
      dataCollection: [],
    });
    expect(s.purpose).toBe("P");
    expect(s.keyDetails[0]).toEqual({
      id: "event_date",
      label: "Event date",
      type: "date",
      value: "2026-09-24",
      required: true,
    });
  });
});

describe("templateFromRow", () => {
  it("maps a row to the AgentTemplate shape, using the id as the key", () => {
    const t = templateFromRow({
      id: "abc-123",
      name: "Reactivation",
      description: "Win back lapsed customers",
      instructions: "# behave",
      default_voice_id: "v1",
      tools: { schedule_callback: true },
      script: {
        purpose: "P",
        goal: "G",
        scriptProse: "S",
        keyDetails: [],
        dataCollection: [],
      },
    });
    expect(t.key).toBe("abc-123");
    expect(t.name).toBe("Reactivation");
    expect(t.instructions).toBe("# behave");
    expect(t.defaultVoiceId).toBe("v1");
    expect(t.tools).toEqual({ schedule_callback: true });
    expect(t.script.purpose).toBe("P");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/agent-template-from-row.unit.test.ts`
Expected: FAIL — cannot resolve `@/lib/agents/templates/from-row`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/agents/templates/from-row.ts
import { normalizeDataCollection } from "@/lib/agents/data-collection";
import type { ToolsEnabled } from "@/lib/agents/prompt";

import {
  normalizeKeyDetails,
  type AgentScript,
  type AgentTemplate,
} from "./types";

/** The columns we select from agent_templates. */
export type AgentTemplateRow = {
  id: string;
  name: string;
  description: string | null;
  instructions: string;
  default_voice_id: string | null;
  tools: unknown;
  script: unknown;
};

/** Parse the `script` jsonb into a typed AgentScript, tolerant of anything
 *  malformed. */
export function scriptFromJson(raw: unknown): AgentScript {
  const rec = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  return {
    purpose: typeof rec.purpose === "string" ? rec.purpose : "",
    goal: typeof rec.goal === "string" ? rec.goal : "",
    keyDetails: normalizeKeyDetails(rec.keyDetails),
    scriptProse: typeof rec.scriptProse === "string" ? rec.scriptProse : "",
    dataCollection: normalizeDataCollection(rec.dataCollection),
  };
}

/** Map an agent_templates DB row into the same AgentTemplate shape the gallery
 *  and builder use for code-seeded templates. The row id becomes the key. */
export function templateFromRow(row: AgentTemplateRow): AgentTemplate {
  return {
    key: row.id,
    name: row.name,
    description: row.description ?? "",
    instructions: row.instructions,
    defaultVoiceId: row.default_voice_id ?? "",
    tools: (row.tools ?? {}) as ToolsEnabled,
    script: scriptFromJson(row.script),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/agent-template-from-row.unit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agents/templates/from-row.ts tests/agent-template-from-row.unit.test.ts
git commit -m "feat(agents): map agent_templates row to AgentTemplate"
```

---

## Task 3: The AI split module

**Files:**

- Create: `src/lib/ai/split-agent-template.ts`
- Test: `tests/split-agent-template.unit.test.ts`

- [ ] **Step 1: Write the failing test** (covers the pure parser + the fallback path — both deterministic, no network/env)

```ts
// tests/split-agent-template.unit.test.ts
import { describe, expect, it } from "vitest";

import {
  parseSplitResponse,
  splitAgentIntoTemplate,
} from "@/lib/ai/split-agent-template";
import { SHARED_INSTRUCTIONS } from "@/lib/agents/templates/instructions";

describe("parseSplitResponse", () => {
  it("parses model JSON and normalizes key details (dates typed)", () => {
    const json = JSON.stringify({
      name: "Webinar invite",
      description: "Invite owners to an event",
      instructions: "# behave",
      purpose: "Invite owners",
      goal: "Book a seat",
      keyDetails: [
        {
          label: "Event date",
          type: "date",
          value: "2026-09-24",
          required: true,
        },
      ],
      scriptProse: "Hi [name]…",
    });
    const out = parseSplitResponse(json, "Fallback Name")!;
    expect(out.name).toBe("Webinar invite");
    expect(out.source).toBe("openai");
    expect(out.keyDetails[0]).toMatchObject({
      id: "event_date",
      type: "date",
      required: true,
    });
  });

  it("returns null on unparseable text", () => {
    expect(parseSplitResponse("not json", "X")).toBeNull();
  });

  it("falls back to the agent name when the model omits a name", () => {
    const out = parseSplitResponse(
      JSON.stringify({ scriptProse: "hi" }),
      "My Agent",
    )!;
    expect(out.name).toBe("My Agent");
    expect(out.instructions).toBe(SHARED_INSTRUCTIONS); // default when omitted
  });
});

describe("splitAgentIntoTemplate fallback", () => {
  it("drops raw prompt into the script when there's no source text", async () => {
    const out = await splitAgentIntoTemplate("", "My Agent");
    expect(out).toEqual({
      name: "My Agent",
      description: "",
      instructions: SHARED_INSTRUCTIONS,
      purpose: "",
      goal: "",
      keyDetails: [],
      scriptProse: "",
      source: "fallback",
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/split-agent-template.unit.test.ts`
Expected: FAIL — cannot resolve `@/lib/ai/split-agent-template`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/ai/split-agent-template.ts
import { SHARED_INSTRUCTIONS } from "@/lib/agents/templates/instructions";
import {
  normalizeKeyDetails,
  type KeyDetail,
} from "@/lib/agents/templates/types";
import { openAiKey } from "@/lib/openai/live";

export interface TemplateSplit {
  name: string;
  description: string;
  instructions: string;
  purpose: string;
  goal: string;
  keyDetails: KeyDetail[];
  scriptProse: string;
  source: "openai" | "fallback";
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" && v.trim() ? v : fallback;
}

/** Parse the model's JSON reply into a TemplateSplit. Returns null if the text
 *  isn't valid JSON. Missing fields degrade to sensible defaults; key details
 *  are normalized (dates stay typed). Pure + deterministic. */
export function parseSplitResponse(
  text: string,
  agentName: string,
): TemplateSplit | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  return {
    name: str(parsed.name, agentName),
    description: str(parsed.description),
    instructions: str(parsed.instructions, SHARED_INSTRUCTIONS),
    purpose: str(parsed.purpose),
    goal: str(parsed.goal),
    keyDetails: normalizeKeyDetails(parsed.keyDetails),
    scriptProse: str(parsed.scriptProse),
    source: "openai",
  };
}

function fallbackSplit(agentName: string, text: string): TemplateSplit {
  return {
    name: agentName,
    description: "",
    instructions: SHARED_INSTRUCTIONS,
    purpose: "",
    goal: "",
    keyDetails: [],
    scriptProse: text,
    source: "fallback",
  };
}

const SYSTEM_PROMPT = `You convert an existing outbound phone-agent prompt into a reusable template by separating two layers.
Reply ONLY with a JSON object with these string keys (plus keyDetails):
- "name": a short template name (3-5 words)
- "description": one line for a gallery card
- "instructions": the DURABLE, campaign-agnostic behavior only — turn-taking, natural human delivery, gatekeeper handling, do-not-call rules, voicemail/IVR handling, AI-disclosure. Remove every campaign specific (company, rep name, event, product, dates).
- "purpose": one line — what this agent is for
- "goal": one line — what counts as success
- "scriptProse": the conversational flow (opener, pitch, objections, sign-off) with the concrete facts REMOVED and referred to generically
- "keyDetails": an array of the concrete facts you removed, each {"label","type","value","required"} where type is "text" | "date" | "time". ANY calendar date MUST be type "date" with value as YYYY-MM-DD. Include rep name, company, event/offer name, dates, times.
Keep instructions faithful to the original behavior. Do not invent facts.`;

/** Split an agent's prompt into a template proposal. Live OpenAI when a key is
 *  set; otherwise (or on any failure/empty input) a graceful fallback that drops
 *  the raw prompt into the script for the admin to split by hand. Never throws. */
export async function splitAgentIntoTemplate(
  promptText: string,
  agentName: string,
): Promise<TemplateSplit> {
  const text = promptText.trim();
  const apiKey = openAiKey();
  if (!apiKey || !text) return fallbackSplit(agentName, text);

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) return fallbackSplit(agentName, text);
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content ?? "";
    return (
      parseSplitResponse(content, agentName) ?? fallbackSplit(agentName, text)
    );
  } catch {
    return fallbackSplit(agentName, text);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/split-agent-template.unit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/split-agent-template.ts tests/split-agent-template.unit.test.ts
git commit -m "feat(ai): split an agent prompt into a template proposal (OpenAI + fallback)"
```

---

## Task 4: The "tidy wording" module

**Files:**

- Create: `src/lib/ai/tidy-prose.ts`
- Test: `tests/tidy-prose.unit.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/tidy-prose.unit.test.ts
import { describe, expect, it } from "vitest";

import { tidyProse } from "@/lib/ai/tidy-prose";

describe("tidyProse", () => {
  it("returns blank input unchanged (no key needed)", async () => {
    expect(await tidyProse("   ")).toBe("   ");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/tidy-prose.unit.test.ts`
Expected: FAIL — cannot resolve `@/lib/ai/tidy-prose`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/ai/tidy-prose.ts
import { openAiKey } from "@/lib/openai/live";

const SYSTEM_PROMPT = `You clean up the wording of an outbound phone-agent script.
Fix grammar, flow, and clarity ONLY. Do not change the meaning, the offer, the
facts, or the structure. Keep it roughly the same length. Reply with ONLY the
cleaned text — no preamble, no quotes, no markdown.`;

/** Grammar/flow cleanup of the script prose, meaning preserved. Live OpenAI when
 *  a key is set; otherwise returns the input unchanged. Never throws. */
export async function tidyProse(text: string): Promise<string> {
  const apiKey = openAiKey();
  if (!apiKey || !text.trim()) return text;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
      }),
    });
    if (!res.ok) return text;
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const cleaned = data.choices?.[0]?.message?.content?.trim();
    return cleaned && cleaned.length > 0 ? cleaned : text;
  } catch {
    return text;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/tidy-prose.unit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/tidy-prose.ts tests/tidy-prose.unit.test.ts
git commit -m "feat(ai): tidy-prose grammar/flow cleanup (meaning preserved)"
```

---

## Task 5: Template resolver (code + DB)

**Files:**

- Create: `src/lib/agents/templates/resolve.ts`
- Test: `tests/agent-template-resolve.unit.test.ts`

- [ ] **Step 1: Write the failing test** (stub Supabase — code path must not hit the DB)

```ts
// tests/agent-template-resolve.unit.test.ts
import { describe, expect, it, vi } from "vitest";

import { resolveTemplate } from "@/lib/agents/templates/resolve";

// Minimal Supabase stub: .from().select().eq().maybeSingle()
function stubSupabase(row: unknown) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: row });
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });
  return { client: { from } as never, from, select, eq, maybeSingle };
}

describe("resolveTemplate", () => {
  it("resolves a code-seed key WITHOUT touching the DB", async () => {
    const s = stubSupabase(null);
    const t = await resolveTemplate("webinar", s.client);
    expect(t?.name).toBe("Webinar invite");
    expect(s.from).not.toHaveBeenCalled();
  });

  it("resolves a DB template by id", async () => {
    const s = stubSupabase({
      id: "abc-123",
      name: "Reactivation",
      description: "d",
      instructions: "# behave",
      default_voice_id: "v1",
      tools: {},
      script: {
        purpose: "P",
        goal: "G",
        scriptProse: "S",
        keyDetails: [],
        dataCollection: [],
      },
    });
    const t = await resolveTemplate("abc-123", s.client);
    expect(t?.name).toBe("Reactivation");
    expect(s.from).toHaveBeenCalledWith("agent_templates");
  });

  it("returns null for an unknown id", async () => {
    const s = stubSupabase(null);
    expect(await resolveTemplate("nope-id", s.client)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/agent-template-resolve.unit.test.ts`
Expected: FAIL — cannot resolve `@/lib/agents/templates/resolve`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/agents/templates/resolve.ts
import type { SupabaseClient } from "@supabase/supabase-js";

import { templateFromRow, type AgentTemplateRow } from "./from-row";
import { getTemplate } from "./index";
import type { AgentTemplate } from "./types";

const TEMPLATE_COLUMNS =
  "id, name, description, instructions, default_voice_id, tools, script";

/** Resolve a gallery "key" to a template. Code-seeded keys (webinar, blank)
 *  resolve from the in-memory registry without a DB hit; anything else is looked
 *  up in agent_templates by id. Returns null if neither matches. */
export async function resolveTemplate(
  key: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
): Promise<AgentTemplate | null> {
  const seed = getTemplate(key);
  if (seed) return seed;

  const { data } = await supabase
    .from("agent_templates")
    .select(TEMPLATE_COLUMNS)
    .eq("id", key)
    .maybeSingle();
  return data ? templateFromRow(data as AgentTemplateRow) : null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/agent-template-resolve.unit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agents/templates/resolve.ts tests/agent-template-resolve.unit.test.ts
git commit -m "feat(agents): resolveTemplate — code seeds first, else DB by id"
```

---

## Task 6: Server actions + draft builder

**Files:**

- Create: `src/lib/agents/template-actions.ts`

- [ ] **Step 1: Write the actions** (admin-gated; mirror the role check in `syncAgent`)

```ts
// src/lib/agents/template-actions.ts
"use server";

import { revalidatePath } from "next/cache";

import { splitAgentIntoTemplate } from "@/lib/ai/split-agent-template";
import { fetchElevenLabsAgentPrompt } from "@/lib/elevenlabs/agents";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/supabase/database.types";

import { normalizeDataCollection } from "./data-collection";
import type { ToolsEnabled } from "./prompt";
import {
  normalizeKeyDetails,
  type AgentScript,
  type AgentTemplate,
} from "./templates/types";

export type TemplateResult = { error: string | null; templateId?: string };

async function requireAdmin(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ userId: string } | { error: string }> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };
  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (me?.role !== "admin")
    return { error: "Only an admin can manage templates." };
  return { userId: user.id };
}

function normalizeScript(raw: AgentScript): AgentScript {
  return {
    purpose: raw.purpose ?? "",
    goal: raw.goal ?? "",
    keyDetails: normalizeKeyDetails(raw.keyDetails),
    scriptProse: raw.scriptProse ?? "",
    dataCollection: normalizeDataCollection(raw.dataCollection),
  };
}

export type TemplateInput = {
  name: string;
  description: string;
  instructions: string;
  defaultVoiceId: string;
  tools: ToolsEnabled;
  script: AgentScript;
};

/** Create a shared template. Admin-only. */
export async function saveTemplate(
  input: TemplateInput,
): Promise<TemplateResult> {
  const supabase = await createClient();
  const auth = await requireAdmin(supabase);
  if ("error" in auth) return { error: auth.error };
  if (!input.name.trim()) return { error: "Give the template a name." };
  if (!input.instructions.trim())
    return { error: "Instructions can't be empty." };

  const { data, error } = await supabase
    .from("agent_templates")
    .insert({
      name: input.name.trim(),
      description: input.description.trim(),
      instructions: input.instructions,
      default_voice_id: input.defaultVoiceId.trim() || null,
      tools: input.tools as unknown as Json,
      script: normalizeScript(input.script) as unknown as Json,
      created_by: auth.userId,
    })
    .select("id")
    .single();
  if (error || !data) return { error: "Could not save the template." };

  revalidatePath("/settings/agents/new");
  return { error: null, templateId: data.id };
}

/** Update an existing shared template. Admin-only. */
export async function updateTemplate(
  id: string,
  input: TemplateInput,
): Promise<TemplateResult> {
  const supabase = await createClient();
  const auth = await requireAdmin(supabase);
  if ("error" in auth) return { error: auth.error };
  if (!input.name.trim()) return { error: "Give the template a name." };

  const { error } = await supabase
    .from("agent_templates")
    .update({
      name: input.name.trim(),
      description: input.description.trim(),
      instructions: input.instructions,
      default_voice_id: input.defaultVoiceId.trim() || null,
      tools: input.tools as unknown as Json,
      script: normalizeScript(input.script) as unknown as Json,
    })
    .eq("id", id);
  if (error) return { error: "Could not update the template." };

  revalidatePath("/settings/agents/new");
  return { error: null, templateId: id };
}

/** Delete a shared template. Admin-only. Agents already built from it are
 *  unaffected (they snapshot instructions/script at creation). */
export async function deleteTemplate(id: string): Promise<TemplateResult> {
  const supabase = await createClient();
  const auth = await requireAdmin(supabase);
  if ("error" in auth) return { error: auth.error };

  const { error } = await supabase
    .from("agent_templates")
    .delete()
    .eq("id", id);
  if (error) return { error: "Could not delete the template." };

  revalidatePath("/settings/agents/new");
  return { error: null, templateId: id };
}

/** Build a template DRAFT (not saved) from an existing agent, by fetching its
 *  prompt (from ElevenLabs for connected agents, else the stored system_prompt)
 *  and running the AI split. Admin-only. Returns an AgentTemplate-shaped draft
 *  the builder pre-fills. */
export async function buildTemplateDraftFromAgent(
  agentId: string,
): Promise<
  | { draft: AgentTemplate; error?: undefined }
  | { error: string; draft?: undefined }
> {
  const supabase = await createClient();
  const auth = await requireAdmin(supabase);
  if ("error" in auth) return { error: auth.error };

  const { data: agent } = await supabase
    .from("agents")
    .select(
      "name, elevenlabs_agent_id, externally_managed, system_prompt, voice_id, tools_enabled",
    )
    .eq("id", agentId)
    .maybeSingle();
  if (!agent) return { error: "That agent no longer exists." };

  let promptText = agent.system_prompt ?? "";
  if (agent.externally_managed && agent.elevenlabs_agent_id) {
    promptText =
      (await fetchElevenLabsAgentPrompt(agent.elevenlabs_agent_id)) ?? "";
  }

  const split = await splitAgentIntoTemplate(promptText, agent.name);
  const draft: AgentTemplate = {
    key: "draft",
    name: split.name,
    description: split.description,
    instructions: split.instructions,
    defaultVoiceId: agent.voice_id ?? "",
    tools: (agent.tools_enabled ?? {}) as ToolsEnabled,
    script: {
      purpose: split.purpose,
      goal: split.goal,
      keyDetails: split.keyDetails,
      scriptProse: split.scriptProse,
      dataCollection: [],
    },
  };
  return { draft };
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/lib/agents/template-actions.ts
git commit -m "feat(agents): template server actions + build-draft-from-agent (admin-gated)"
```

---

## Task 7: Builder gains a template-editor mode

**Files:**

- Modify: `src/app/(app)/settings/agents/agent-builder.tsx`

Add a `mode` ("agent" default | "template"), a `templateId` (edit vs create), template Name/Description, an editable Instructions textarea (template mode only), a tidy-wording button, and template save wiring. In agent mode nothing changes.

- [ ] **Step 1: Extend imports + props + state**

At the top imports, add:

```ts
import { saveTemplate, updateTemplate } from "@/lib/agents/template-actions";
import { tidyProse } from "@/lib/ai/tidy-prose";
```

Change the component signature and add state. Replace the `export function AgentBuilder({ template, voices, agent }: {...})` prop block with:

```tsx
export function AgentBuilder({
  template,
  voices,
  agent,
  mode = "agent",
  templateId,
}: {
  template: AgentTemplate;
  voices: FixedVoice[];
  agent?: BuilderAgent;
  mode?: "agent" | "template";
  templateId?: string;
}) {
```

Change the existing name initializer so template mode pre-fills from the template
(critical for edit — otherwise the name blanks out). Replace:

```tsx
const [name, setName] = useState(agent?.name ?? "");
```

with:

```tsx
const [name, setName] = useState(
  agent?.name ?? (mode === "template" ? template.name : ""),
);
```

Then, right after that line, add template-only state:

```tsx
const isTemplate = mode === "template";
// In template mode `name` holds the TEMPLATE name; description + editable
// instructions are template-only.
const [description, setDescription] = useState(template.description ?? "");
const [instructions, setInstructions] = useState(template.instructions);
```

Purpose/goal/keyDetails/scriptProse already fall back to `template.script.*` when
`agent` is undefined (template mode), so they pre-fill correctly with no change.

- [ ] **Step 2: Branch `save()` for template mode**

Replace the body of `save()` after the `if (errors.length) …` guard with:

```tsx
startTransition(async () => {
  if (isTemplate) {
    const payload = {
      name,
      description,
      instructions,
      defaultVoiceId: voiceId,
      tools,
      script,
    };
    const result = templateId
      ? await updateTemplate(templateId, payload)
      : await saveTemplate(payload);
    if (result.error) {
      toast.error(result.error);
    } else {
      toast.success(templateId ? "Template updated." : "Template saved.");
      router.push("/settings/agents/new");
    }
    return;
  }
  const payload = {
    name,
    voiceId,
    script,
    toolsEnabled: tools,
    knowledgeBaseIds: agent?.knowledgeBaseIds ?? [],
  };
  const result = agent
    ? await updateAgentScript(agent.id, payload)
    : await createAgentFromTemplate({ templateKey: template.key, ...payload });
  if (result.error) {
    toast.error(result.error);
  } else {
    toast.success(isEdit ? "Agent updated." : "Agent created.");
    router.push("/settings/agents");
  }
});
```

- [ ] **Step 3: Template Name/Description + editable Instructions + tidy button**

Change the Name label so template mode says "Template name":

```tsx
<Label htmlFor="agent-name">
  {isTemplate ? "Template name" : "Agent name"}
</Label>
```

Immediately after the Name field's closing `</div>`, add (template mode only) a Description field:

```tsx
{
  isTemplate ? (
    <div className="flex flex-col gap-2">
      <Label htmlFor="template-description">Description</Label>
      <Input
        id="template-description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="One line shown on the gallery card"
      />
    </div>
  ) : null;
}
```

Replace the locked Instructions `<Card>`'s `<CardContent>` body so template mode shows an editable textarea instead of the read-only paragraph:

```tsx
<CardContent>
  {isTemplate ? (
    <Textarea
      aria-label="Instructions"
      value={instructions}
      onChange={(e) => setInstructions(e.target.value)}
      rows={14}
      className="font-mono text-xs"
    />
  ) : (
    <p className="text-muted-foreground text-xs">
      Locked, proven behavior — turn-taking, human delivery, gatekeeper
      handling, do-not-call, voicemail/IVR. You can&apos;t break it, and
      don&apos;t need to.
    </p>
  )}
</CardContent>
```

Add a tidy button under the Script prose textarea (both modes; it just cleans wording). After the `<Textarea id="agent-script" … />`, add:

```tsx
<TidyButton value={scriptProse} onChange={setScriptProse} />
```

And add the component at the bottom of the file:

```tsx
function TidyButton({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [pending, start] = useTransition();
  const [prev, setPrev] = useState<string | null>(null);
  function tidy() {
    start(async () => {
      const before = value;
      const cleaned = await tidyProse(before);
      if (cleaned === before) {
        toast.message("Nothing to tidy.");
        return;
      }
      setPrev(before);
      onChange(cleaned);
      toast.success("Tidied the wording.");
    });
  }
  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={tidy}
        disabled={pending}
      >
        <Sparkles className="size-4" />{" "}
        {pending ? "Tidying…" : "Tidy up wording"}
      </Button>
      {prev !== null ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            onChange(prev);
            setPrev(null);
          }}
        >
          Undo
        </Button>
      ) : null}
    </div>
  );
}
```

(Note: `useTransition` and `Sparkles` are already imported in this file.)

- [ ] **Step 4: Change the save button + heading label for template mode**

The save `<Button>` label — replace the ternary text with:

```tsx
{
  pending
    ? "Saving…"
    : isTemplate
      ? templateId
        ? "Save template"
        : "Save as template"
      : isEdit
        ? "Save changes"
        : "Save agent";
}
```

And the `<h1>`/subtitle can stay; optionally set the heading to "Template" in template mode (not required for tests).

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npm run build`
Expected: clean; existing agent-mode routes still compile.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/settings/agents/agent-builder.tsx"
git commit -m "feat(agents): builder template-editor mode + tidy-wording button"
```

---

## Task 8: Template editor routes

**Files:**

- Create: `src/app/(app)/settings/agents/templates/new/page.tsx`
- Create: `src/app/(app)/settings/agents/templates/[id]/edit/page.tsx`

- [ ] **Step 1: The "new from agent" route**

```tsx
// src/app/(app)/settings/agents/templates/new/page.tsx
import { redirect } from "next/navigation";

import { buildTemplateDraftFromAgent } from "@/lib/agents/template-actions";
import { FIXED_VOICES } from "@/lib/elevenlabs/voices";
import { createClient } from "@/lib/supabase/server";

import { AgentBuilder } from "../../agent-builder";

export default async function NewTemplatePage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const { from } = await searchParams;
  if (!from) redirect("/settings/agents");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (me?.role !== "admin") redirect("/settings/agents");

  const result = await buildTemplateDraftFromAgent(from);
  if (result.error) redirect("/settings/agents");

  return (
    <AgentBuilder
      template={result.draft}
      voices={FIXED_VOICES}
      mode="template"
    />
  );
}
```

- [ ] **Step 2: The "edit template" route**

```tsx
// src/app/(app)/settings/agents/templates/[id]/edit/page.tsx
import { notFound, redirect } from "next/navigation";

import { getTemplate } from "@/lib/agents/templates";
import { resolveTemplate } from "@/lib/agents/templates/resolve";
import { FIXED_VOICES } from "@/lib/elevenlabs/voices";
import { createClient } from "@/lib/supabase/server";

import { AgentBuilder } from "../../../agent-builder";

export default async function EditTemplatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Code seeds (webinar, blank) aren't editable — only DB templates are.
  if (getTemplate(id)) redirect("/settings/agents/new");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (me?.role !== "admin") redirect("/settings/agents");

  const template = await resolveTemplate(id, supabase);
  if (!template) notFound();

  return (
    <AgentBuilder
      template={template}
      voices={FIXED_VOICES}
      mode="template"
      templateId={id}
    />
  );
}
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npm run build`
Expected: clean; the two new routes compile.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/settings/agents/templates"
git commit -m "feat(agents): template editor routes (new-from-agent + edit)"
```

---

## Task 9: Gallery DB templates + agents-list "Save as template"

**Files:**

- Create: `src/app/(app)/settings/agents/delete-template-button.tsx`
- Modify: `src/app/(app)/settings/agents/template-gallery.tsx`
- Modify: `src/app/(app)/settings/agents/new/page.tsx`
- Modify: `src/app/(app)/settings/agents/page.tsx`

- [ ] **Step 1: Delete-template client button**

```tsx
// src/app/(app)/settings/agents/delete-template-button.tsx
"use client";

import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { deleteTemplate } from "@/lib/agents/template-actions";

export function DeleteTemplateButton({
  id,
  name,
}: {
  id: string;
  name: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={`Delete ${name}`}
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await deleteTemplate(id);
          if (r.error) toast.error(r.error);
          else {
            toast.success("Template deleted.");
            router.refresh();
          }
        })
      }
    >
      <Trash2 className="size-4" />
    </Button>
  );
}
```

- [ ] **Step 2: Gallery renders DB templates (with admin edit/delete)**

Change `TemplateGallery` to accept props and render DB cards. Replace the component signature + the card grid:

```tsx
// src/app/(app)/settings/agents/template-gallery.tsx  (key changes)
import { ArrowRight, PencilRuler, Pencil } from "lucide-react";
import { DeleteTemplateButton } from "./delete-template-button";

export type DbTemplateCard = { id: string; name: string; description: string };

export function TemplateGallery({
  dbTemplates,
  isAdmin,
}: {
  dbTemplates: DbTemplateCard[];
  isAdmin: boolean;
}) {
  // …existing Breadcrumbs + heading unchanged…
  // In the grid, render code seeds first (existing AGENT_TEMPLATES map), then:
  //   {dbTemplates.map((t) => ( <card linking to /settings/agents/new/${t.id}> … with, when isAdmin, an Edit link to /settings/agents/templates/${t.id}/edit and <DeleteTemplateButton/> ))}
}
```

Full DB-card block to add after the code-seed cards:

```tsx
{
  dbTemplates.map((t) => (
    <div
      key={t.id}
      className="border-border hover:border-foreground/20 group relative flex flex-col gap-1 rounded-2xl border p-5 transition-colors"
    >
      <Link
        href={`/settings/agents/new/${t.id}`}
        className="flex flex-col gap-1"
      >
        <span className="text-foreground text-sm font-semibold">{t.name}</span>
        <span className="text-muted-foreground text-xs">{t.description}</span>
      </Link>
      {isAdmin ? (
        <div className="absolute top-3 right-3 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <Link
            href={`/settings/agents/templates/${t.id}/edit`}
            aria-label={`Edit ${t.name}`}
            className="text-muted-foreground hover:text-foreground"
          >
            <Pencil className="size-4" />
          </Link>
          <DeleteTemplateButton id={t.id} name={t.name} />
        </div>
      ) : null}
    </div>
  ));
}
```

- [ ] **Step 3: `new/page.tsx` fetches DB templates + isAdmin**

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

  const [{ data: rows }, { data: me }] = await Promise.all([
    supabase
      .from("agent_templates")
      .select("id, name, description")
      .order("created_at", { ascending: false }),
    supabase.from("profiles").select("role").eq("id", user.id).single(),
  ]);

  const dbTemplates = (rows ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description ?? "",
  }));

  return (
    <TemplateGallery dbTemplates={dbTemplates} isAdmin={me?.role === "admin"} />
  );
}
```

- [ ] **Step 4: Agents list — admin-only "Save as template" per row**

In `src/app/(app)/settings/agents/page.tsx`: after the existing `user` fetch, add an admin check:

```tsx
const { data: me } = await supabase
  .from("profiles")
  .select("role")
  .eq("id", user.id)
  .single();
const isAdmin = me?.role === "admin";
```

In the per-row actions cell (the `<div className="flex justify-end gap-1 …">`), add as the first child, admin-only:

```tsx
{
  isAdmin ? (
    <Button
      variant="ghost"
      size="sm"
      asChild
      aria-label={`Save ${agent.name} as template`}
    >
      <Link href={`/settings/agents/templates/new?from=${agent.id}`}>
        Save as template
      </Link>
    </Button>
  ) : null;
}
```

(`Button`, `Link` are already imported in this file.)

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npm run build`
Expected: clean; gallery + agents list compile.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/settings/agents/delete-template-button.tsx" "src/app/(app)/settings/agents/template-gallery.tsx" "src/app/(app)/settings/agents/new/page.tsx" "src/app/(app)/settings/agents/page.tsx"
git commit -m "feat(agents): gallery shows saved templates; admin save-as-template + edit/delete"
```

---

## Task 10: Playwright e2e (contract)

**Files:**

- Create: `tests/agent-templates-save.spec.ts`

- [ ] **Step 1: Write the e2e** (admin saves a template via the no-OpenAI fallback; a member never sees the button)

```ts
// tests/agent-templates-save.spec.ts
import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });
test.describe.configure({ mode: "serial" });

test.describe("Save as template", () => {
  const stamp = Date.now();
  const agentName = `E2E Tmpl Agent ${stamp}`;
  const templateName = `E2E Template ${stamp}`;
  let admin: SupabaseClient;
  let agentId: string;

  test.beforeAll(async () => {
    admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    await admin.from("agent_templates").delete().like("name", "E2E Template %");
    await admin.from("agents").delete().like("name", "E2E Tmpl Agent %");
    const { data: owner } = await admin
      .from("profiles")
      .select("id")
      .eq("email", process.env.E2E_TEST_EMAIL ?? "")
      .single();
    const { data: seed } = await admin
      .from("agents")
      .insert({
        owner_id: owner!.id,
        name: agentName,
        system_prompt: "Say hi and book a demo on 2026-09-24.",
      })
      .select("id")
      .single();
    agentId = seed!.id;
  });

  test.afterAll(async () => {
    await admin.from("agent_templates").delete().like("name", "E2E Template %");
    await admin.from("agents").delete().like("name", "E2E Tmpl Agent %");
  });

  test("admin saves an agent as a shared template that appears in the gallery", async ({
    page,
  }) => {
    await page.goto(`/settings/agents/templates/new?from=${agentId}`);
    // Builder is in template mode: a Template name + editable Instructions.
    await page.getByLabel("Template name").fill(templateName);
    await page.getByLabel("Description").fill("E2E win-back");
    // Purpose/Goal are required by validateScript.
    await page.getByLabel("Purpose").fill("Win back lapsed customers.");
    await page.getByLabel("Goal — what counts as success").fill("Book a call.");
    await page.getByRole("button", { name: /Save as template/ }).click();

    await expect(page).toHaveURL(/\/settings\/agents\/new$/);
    await expect(page.getByText(templateName)).toBeVisible();

    const { data: tmpl } = await admin
      .from("agent_templates")
      .select("name, instructions, script")
      .eq("name", templateName)
      .single();
    expect(tmpl?.instructions).toContain("exactly ONE question");
    expect((tmpl?.script as { purpose: string }).purpose).toBe(
      "Win back lapsed customers.",
    );
  });
});
```

- [ ] **Step 2: Commit** (contract only — not run in-session; see Task 11 note)

```bash
git add tests/agent-templates-save.spec.ts
git commit -m "test(agents): e2e for save-as-template (admin flow, fallback split)"
```

---

## Task 11: Verification sweep

- [ ] **Step 1: Unit tests**

Run: `npm run test:unit`
Expected: all pass, including the 4 new suites (`agent-template-from-row`, `split-agent-template`, `tidy-prose`, `agent-template-resolve`).

- [ ] **Step 2: Types + build + scoped lint**

Run: `npx tsc --noEmit && npm run build`
Then lint only the changed files (repo-wide `eslint` is noisy):

```bash
npx eslint src/lib/agents/templates/from-row.ts src/lib/agents/templates/resolve.ts src/lib/ai/split-agent-template.ts src/lib/ai/tidy-prose.ts src/lib/agents/template-actions.ts "src/app/(app)/settings/agents/agent-builder.tsx" "src/app/(app)/settings/agents/template-gallery.tsx" "src/app/(app)/settings/agents/delete-template-button.tsx" "src/app/(app)/settings/agents/new/page.tsx" "src/app/(app)/settings/agents/page.tsx" "src/app/(app)/settings/agents/templates/new/page.tsx" "src/app/(app)/settings/agents/templates/[id]/edit/page.tsx"
```

Expected: 0 errors.

- [ ] **Step 3: Manual smoke (optional, admin session)**

`npm run dev`, then as an admin: Agents list → "Save as template" on an agent → the split pre-fills the builder → edit → Save → the card shows in the gallery → Edit it → Delete it. As a non-admin, confirm "Save as template" and the edit/delete affordances are absent.

- [ ] **Step 4: Push + PR**

```bash
git push -u origin feat/agent-save-as-template
gh pr create --title "Save as template — the flywheel (Phase 2)" --body "Admins turn any agent (incl. imported ElevenLabs ones) into a shared template via an AI-proposed split corrected in the existing builder. New agent_templates table (migration applied to prod). Spec: docs/superpowers/specs/2026-08-15-agent-save-as-template-design.md"
```

> Playwright note (same as Phase 1): `tests/agent-templates-save.spec.ts` is a committed **contract**, exercised via the no-OpenAI fallback so it needs no live OpenAI/EL. Run it in a dedicated test env with `playwright/.auth/user.json` seeded; do NOT run against live prod in-session.

---

## Self-Review notes (for the executor)

- **Spec coverage:** admin-curated shared shelf (T1 RLS + T9 admin gating), AI split (T3) with fetch-from-EL (T6 `buildTemplateDraftFromAgent`), reuse builder as review UX (T7 template mode), `agent_templates` table + gallery union + resolver (T1, T5, T9), edit/delete (T6 actions, T8 edit route, T9 delete button), tidy wording (T4 + T7 button), two-layer permissions (T6 `requireAdmin` + T1 RLS + T8/T9 route/UI gating). All spec sections map to a task.
- **Type consistency:** `TemplateSplit` (T3) → consumed by `buildTemplateDraftFromAgent` (T6) → `AgentTemplate` draft → `AgentBuilder` template mode (T7). `TemplateInput` (T6) is what `saveTemplate`/`updateTemplate` accept and what the builder sends. `templateFromRow`/`AgentTemplateRow` (T2) reused by `resolveTemplate` (T5).
- **Out of scope confirmed:** no per-user private templates, no promote flow, no template versioning, no change to agent creation/sync.
- **Env realities:** T1 pushes a new table to prod (safe — new table). The AI split/tidy call OpenAI live in prod but degrade to deterministic fallback; unit tests only exercise the pure parser + fallback. The e2e uses the fallback path so it creates no external side effects.
