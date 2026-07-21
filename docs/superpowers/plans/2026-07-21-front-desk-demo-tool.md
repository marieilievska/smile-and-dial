# Front-Desk Demo Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a seventh ElevenLabs server tool, `demo_front_desk`, that researches a prospect's business on the web mid-call and returns a speakable "front desk brief" the agent can role-play from.

**Architecture:** A new pure-ish research module (`src/lib/openai/business-research.ts`) calls OpenAI's Responses API with the `web_search` tool and a strict JSON schema, degrading to a generic brief on any failure. A handler in the existing tool-webhook dispatcher resolves the lead, calls the module, opportunistically fills `leads.website`, and logs to `system_events`. The tool key is added to the five exhaustive `ToolKey`/`ServerToolKey` sites, which gives us the wizard checkbox and connected-agent sync for free.

**Tech Stack:** Next.js (App Router), TypeScript, Supabase (service-role in webhooks), OpenAI Responses API (`gpt-5.4-mini` + `web_search`), Vitest for unit tests, Playwright for the endpoint contract.

**Design spec:** `docs/superpowers/specs/2026-07-21-live-front-desk-demo-design.md`

---

## Ground rules for this plan

- **No database migration.** Nothing in this plan alters schema. `leads.website` and `system_events` already exist.
- **No behaviour change to existing agents.** Every agent's `toolsEnabled` stays as-is; an unchecked tool is never attached.
- **Every failure path degrades, never errors.** The webhook always returns HTTP 200 with a speakable message — that is the existing route contract (`src/app/api/elevenlabs/tools/[tool]/route.ts:48`).
- **Run from the repo root:** `C:\Users\Marija\Documents\smile-and-dial-finalVersion`, on branch `feat/live-front-desk-demo`.

## File structure

| File                                                      | Responsibility                                                                                                                                                                                      |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/openai/business-research.ts` (create)            | All research logic: URL handling, request building, response parsing, brief shaping, the network call. Pure functions exported separately from the one network function so they can be unit-tested. |
| `tests/business-research.unit.test.ts` (create)           | Vitest coverage of every pure function. No network.                                                                                                                                                 |
| `tests/business-research-live.unit.test.ts` (create)      | Opt-in live check that hits the real OpenAI API and prints a real brief. Skipped unless `RESEARCH_LIVE=1`.                                                                                          |
| `src/lib/agents/prompt.ts` (modify)                       | `ALL_TOOLS`, `TOOL_LABELS`, `TOOL_BLOCKS`                                                                                                                                                           |
| `src/lib/elevenlabs/server-tools.ts` (modify)             | `TOOL_DESCRIPTIONS`, `bodySchemaFor`, per-tool timeout                                                                                                                                              |
| `src/lib/elevenlabs/tool-webhook.ts` (modify)             | `SERVER_TOOL_KEYS`, `CallContext`, the handler                                                                                                                                                      |
| `src/app/(app)/settings/agents/agent-wizard.tsx` (modify) | `TOOL_HELPERS`                                                                                                                                                                                      |
| `tests/elevenlabs-tools.spec.ts` (modify)                 | Endpoint contract test                                                                                                                                                                              |

---

## Task 1: URL helpers

Two pure functions. `researchDomain` produces the bare domain we pin the web search to. `ownSiteOrigin` decides whether a research source URL is the business's own site (safe to store on the lead) or a directory listing (must not be stored — storing Yelp links would poison the domain-pin for every future search).

**Files:**

- Create: `src/lib/openai/business-research.ts`
- Create: `tests/business-research.unit.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/business-research.unit.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  ownSiteOrigin,
  researchDomain,
} from "../src/lib/openai/business-research";

describe("researchDomain", () => {
  it("strips protocol, www and path", () => {
    expect(researchDomain("https://www.BellaNails.com/services")).toBe(
      "bellanails.com",
    );
  });

  it("accepts a bare domain with no protocol", () => {
    expect(researchDomain("bellanails.com")).toBe("bellanails.com");
  });

  it("returns null for empty, blank or unusable input", () => {
    expect(researchDomain(null)).toBeNull();
    expect(researchDomain("   ")).toBeNull();
    expect(researchDomain("not a url")).toBeNull();
    expect(researchDomain("localhost")).toBeNull();
  });
});

describe("ownSiteOrigin", () => {
  it("returns the origin of the business's own site", () => {
    expect(ownSiteOrigin("https://bellanails.com/book?x=1")).toBe(
      "https://bellanails.com",
    );
  });

  it("rejects directory and social listings so leads.website stays useful", () => {
    expect(ownSiteOrigin("https://www.yelp.com/biz/bella-nails")).toBeNull();
    expect(ownSiteOrigin("https://maps.google.com/place/bella")).toBeNull();
    expect(ownSiteOrigin("https://facebook.com/bellanails")).toBeNull();
  });

  it("does not reject a real site whose name merely starts like a directory", () => {
    expect(ownSiteOrigin("https://googlenails.com")).toBe(
      "https://googlenails.com",
    );
  });

  it("returns null when there is no source url", () => {
    expect(ownSiteOrigin(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/business-research.unit.test.ts`
Expected: FAIL — `Failed to resolve import "../src/lib/openai/business-research"`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/lib/openai/business-research.ts`:

```ts
import "server-only";

/**
 * Live business research behind the `demo_front_desk` tool.
 *
 * The agent calls that tool mid-call to role-play the prospect's own front
 * desk, so it needs a short, accurate, SPEAKABLE brief about a business we
 * usually know almost nothing about — in production the vast majority of leads
 * carry only a company name and a city.
 *
 * We therefore go to the web (OpenAI Responses API + its `web_search` tool)
 * rather than to our own columns. Everything here degrades to a generic brief
 * instead of failing: the caller is on the phone, so "no answer" must still be
 * an answer the agent can speak.
 *
 * The pure functions are exported separately from `researchBusiness` (the only
 * one that touches the network) so they can be unit-tested offline.
 */

/** Hosts that are directories/social pages rather than a business's own site.
 *  Matched on the registrable-ish domain, so "maps.google.com" and "google.com"
 *  both hit while "googlenails.com" does not. */
const DIRECTORY_HOSTS = [
  "google.",
  "yelp.",
  "facebook.",
  "instagram.",
  "tripadvisor.",
  "yellowpages.",
  "mapquest.",
  "linkedin.",
  "bing.",
];

/** The bare domain to pin a web search to ("https://www.Foo.com/x" → "foo.com").
 *  Null when we have nothing usable, in which case the search runs open. */
export function researchDomain(
  website: string | null | undefined,
): string | null {
  const raw = website?.trim();
  if (!raw) return null;
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const host = new URL(withProtocol).hostname.toLowerCase();
    const bare = host.startsWith("www.") ? host.slice(4) : host;
    // A hostname with no dot is a local/invalid name, not a business site.
    return bare.includes(".") ? bare : null;
  } catch {
    return null;
  }
}

/** The business's OWN site origin from a research source URL, or null when the
 *  source was a directory listing. We store this on `leads.website`, and that
 *  column is what pins the NEXT research run — so letting a Yelp URL in would
 *  quietly degrade every future search for that lead. */
export function ownSiteOrigin(sourceUrl: string | null): string | null {
  const domain = researchDomain(sourceUrl);
  if (!domain) return null;
  const isDirectory = DIRECTORY_HOSTS.some(
    (h) => domain.startsWith(h) || domain.includes(`.${h}`),
  );
  return isDirectory ? null : `https://${domain}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/business-research.unit.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/openai/business-research.ts tests/business-research.unit.test.ts
git commit -m "feat(research): url helpers for front-desk business research

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: The brief type and its fallback

`FrontDeskBrief` is what the agent speaks from. `fallbackBrief` is what we return when research tells us nothing — it must still be usable, because the caller is waiting.

**Files:**

- Modify: `src/lib/openai/business-research.ts`
- Modify: `tests/business-research.unit.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/business-research.unit.test.ts` (and add `fallbackBrief` plus the `ResearchInputs` type to the existing import at the top of the file):

```ts
describe("fallbackBrief", () => {
  const inputs = {
    company: "Bella Nails",
    city: "Cicero",
    state: "IL",
    website: null,
    heardOnCall: null,
  };

  it("is speakable even though it knows nothing", () => {
    const brief = fallbackBrief(inputs);
    expect(brief.found).toBe(false);
    expect(brief.business_name_spoken).toBe("Bella Nails");
    expect(brief.receptionist_greeting).toBe(
      "Thanks for calling Bella Nails, how can I help you?",
    );
    expect(brief.common_caller_reasons.length).toBeGreaterThan(0);
    expect(brief.services).toEqual([]);
    expect(brief.source_url).toBeNull();
  });

  it("blocks the specifics an owner would instantly catch", () => {
    expect(fallbackBrief(inputs).do_not_claim).toEqual(
      expect.arrayContaining(["prices", "opening hours"]),
    );
  });

  it("keeps the greeting natural when we have no company name", () => {
    const brief = fallbackBrief({ ...inputs, company: null });
    expect(brief.business_name_spoken).toBe("the business");
    expect(brief.receptionist_greeting).toBe(
      "Thanks for calling, how can I help you?",
    );
  });

  it("uses what the caller already said as the description", () => {
    const brief = fallbackBrief({
      ...inputs,
      heardOnCall: "we do gel manicures and lash extensions",
    });
    expect(brief.what_they_do).toBe("we do gel manicures and lash extensions");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/business-research.unit.test.ts`
Expected: FAIL — `fallbackBrief is not exported` / not defined.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/lib/openai/business-research.ts`:

```ts
export type ResearchInputs = {
  company: string | null;
  city: string | null;
  state: string | null;
  website: string | null;
  /** Anything the caller volunteered on the call. Treated as authoritative —
   *  it comes from the owner's own mouth, seconds ago. */
  heardOnCall: string | null;
};

/** What the agent role-plays from. Every field is short enough to say out loud. */
export type FrontDeskBrief = {
  /** False when research could not confirm it found the RIGHT business. The
   *  agent keeps the demo general in that case. */
  found: boolean;
  business_name_spoken: string;
  what_they_do: string;
  services: string[];
  common_caller_reasons: string[];
  receptionist_greeting: string;
  /** Things the agent must NOT state because research could not verify them. */
  do_not_claim: string[];
  source_url: string | null;
};

/** True of practically every local service business, so it is safe to assume
 *  when research found nothing. */
const GENERIC_CALLER_REASONS = [
  "booking or changing an appointment",
  "hours and location",
  "what something costs",
];

/** With no verified facts, everything specific is off-limits. Prices and hours
 *  lead the list: they are what an owner catches instantly. */
const UNVERIFIED_CLAIMS = [
  "prices",
  "opening hours",
  "specific services",
  "staff names",
];

/** The brief we return when research fails, times out, or can't identify the
 *  business. Deliberately still usable — the caller is mid-conversation, so an
 *  empty answer is worse than a general one. */
export function fallbackBrief(inputs: ResearchInputs): FrontDeskBrief {
  const company = inputs.company?.trim() ?? "";
  return {
    found: false,
    business_name_spoken: company || "the business",
    what_they_do: inputs.heardOnCall?.trim() ?? "",
    services: [],
    common_caller_reasons: [...GENERIC_CALLER_REASONS],
    receptionist_greeting: company
      ? `Thanks for calling ${company}, how can I help you?`
      : "Thanks for calling, how can I help you?",
    do_not_claim: [...UNVERIFIED_CLAIMS],
    source_url: null,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/business-research.unit.test.ts`
Expected: PASS — 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/openai/business-research.ts tests/business-research.unit.test.ts
git commit -m "feat(research): front-desk brief type and its degraded fallback

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Shaping the model's answer into a brief

`buildFrontDeskBrief` takes whatever JSON the model produced (possibly partial, possibly junk) and returns a complete, safe brief. It must never throw and never return a half-populated object.

**Files:**

- Modify: `src/lib/openai/business-research.ts`
- Modify: `tests/business-research.unit.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/business-research.unit.test.ts` (add `buildFrontDeskBrief` to the import at the top):

```ts
describe("buildFrontDeskBrief", () => {
  const inputs = {
    company: "Bella Nails",
    city: "Cicero",
    state: "IL",
    website: null,
    heardOnCall: null,
  };

  const good = {
    found: true,
    business_name_spoken: "Bella Nails",
    what_they_do: "A nail salon offering manicures and pedicures.",
    services: ["gel manicures", "pedicures", "lash extensions"],
    common_caller_reasons: ["booking", "prices", "walk-in availability"],
    receptionist_greeting: "Thanks for calling Bella Nails!",
    do_not_claim: ["exact prices"],
    source_url: "https://bellanails.com",
  };

  it("passes a complete answer through", () => {
    expect(buildFrontDeskBrief(inputs, good)).toEqual(good);
  });

  it("falls back entirely when the model could not identify the business", () => {
    expect(buildFrontDeskBrief(inputs, { ...good, found: false })).toEqual(
      fallbackBrief(inputs),
    );
  });

  it("falls back entirely on junk input", () => {
    expect(buildFrontDeskBrief(inputs, null)).toEqual(fallbackBrief(inputs));
    expect(buildFrontDeskBrief(inputs, "nope")).toEqual(fallbackBrief(inputs));
  });

  it("fills blank fields from the fallback rather than speaking empties", () => {
    const brief = buildFrontDeskBrief(inputs, {
      ...good,
      receptionist_greeting: "   ",
      common_caller_reasons: [],
    });
    expect(brief.receptionist_greeting).toBe(
      "Thanks for calling Bella Nails, how can I help you?",
    );
    expect(brief.common_caller_reasons).toEqual(
      fallbackBrief(inputs).common_caller_reasons,
    );
  });

  it("drops non-strings, blanks and overruns from list fields", () => {
    const brief = buildFrontDeskBrief(inputs, {
      ...good,
      services: ["a", "", "  ", 7, null, "b", "c", "d", "e", "f"],
    });
    expect(brief.services).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("normalises a missing source url to null", () => {
    expect(
      buildFrontDeskBrief(inputs, { ...good, source_url: "" }).source_url,
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/business-research.unit.test.ts`
Expected: FAIL — `buildFrontDeskBrief is not exported` / not defined.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/lib/openai/business-research.ts`:

```ts
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Clean a model-supplied list: strings only, trimmed, no blanks, capped. */
function strArray(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, max);
}

/**
 * Turn whatever the model returned into a complete brief.
 *
 * Two rules: a `found: false` (or unparseable) answer falls back WHOLESALE
 * rather than field-by-field — a half-identified business is worse than an
 * honestly generic one — and any individual field that comes back blank is
 * filled from the fallback so the agent never has to speak an empty string.
 */
export function buildFrontDeskBrief(
  inputs: ResearchInputs,
  parsed: unknown,
): FrontDeskBrief {
  const base = fallbackBrief(inputs);
  if (!parsed || typeof parsed !== "object") return base;
  const p = parsed as Record<string, unknown>;
  if (p.found !== true) return base;

  const reasons = strArray(p.common_caller_reasons, 3);
  return {
    found: true,
    business_name_spoken:
      str(p.business_name_spoken) || base.business_name_spoken,
    what_they_do: str(p.what_they_do) || base.what_they_do,
    services: strArray(p.services, 5),
    common_caller_reasons:
      reasons.length > 0 ? reasons : base.common_caller_reasons,
    receptionist_greeting:
      str(p.receptionist_greeting) || base.receptionist_greeting,
    // Whatever research itself flagged as unverified. NOT merged with the
    // fallback list: once we've confirmed the business, blanket-blocking
    // prices and hours would gut the demo, and the agent's own prompt frames
    // the whole thing as a sample anyway.
    do_not_claim: strArray(p.do_not_claim, 6),
    source_url: str(p.source_url) || null,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/business-research.unit.test.ts`
Expected: PASS — 17 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/openai/business-research.ts tests/business-research.unit.test.ts
git commit -m "feat(research): shape the model answer into a safe front-desk brief

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Reading the Responses API envelope

The Responses API returns an `output` array of typed items. With `web_search` enabled that array contains a `web_search_call` item **before** the message, so a naive "first item" read gets nothing. `output_text` is a convenience field the SDKs add and the raw HTTP body may omit — so try it, then walk.

**Files:**

- Modify: `src/lib/openai/business-research.ts`
- Modify: `tests/business-research.unit.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/business-research.unit.test.ts` (add `extractOutputText` to the import at the top):

```ts
describe("extractOutputText", () => {
  it("prefers the output_text convenience field", () => {
    expect(extractOutputText({ output_text: '{"found":true}' })).toBe(
      '{"found":true}',
    );
  });

  it("walks the output array past the web_search_call item", () => {
    const body = {
      output: [
        { type: "web_search_call", id: "ws_1", status: "completed" },
        {
          type: "message",
          content: [{ type: "output_text", text: '{"found":true}' }],
        },
      ],
    };
    expect(extractOutputText(body)).toBe('{"found":true}');
  });

  it("accepts a content part typed plain text", () => {
    const body = {
      output: [{ type: "message", content: [{ type: "text", text: "hi" }] }],
    };
    expect(extractOutputText(body)).toBe("hi");
  });

  it("returns empty string for anything unusable", () => {
    expect(extractOutputText(null)).toBe("");
    expect(extractOutputText({})).toBe("");
    expect(extractOutputText({ output_text: "   " })).toBe("");
    expect(extractOutputText({ output: [{ type: "web_search_call" }] })).toBe(
      "",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/business-research.unit.test.ts`
Expected: FAIL — `extractOutputText is not exported` / not defined.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/lib/openai/business-research.ts`:

```ts
/**
 * Pull the model's text out of a raw Responses API body.
 *
 * `output_text` is a convenience field the official SDKs synthesise; over plain
 * fetch it may be absent, so we fall back to walking `output`. That array is
 * NOT just the message — with `web_search` enabled it also carries
 * `web_search_call` items, which is why we look for the message item by type
 * rather than taking `output[0]`.
 */
export function extractOutputText(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const b = body as Record<string, unknown>;

  const direct = str(b.output_text);
  if (direct) return direct;

  if (!Array.isArray(b.output)) return "";
  for (const item of b.output) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    if (it.type !== "message" || !Array.isArray(it.content)) continue;
    for (const part of it.content) {
      if (!part || typeof part !== "object") continue;
      const pt = part as Record<string, unknown>;
      const isText = pt.type === "output_text" || pt.type === "text";
      if (isText && typeof pt.text === "string") return pt.text;
    }
  }
  return "";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/business-research.unit.test.ts`
Expected: PASS — 21 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/openai/business-research.ts tests/business-research.unit.test.ts
git commit -m "feat(research): tolerant reader for the Responses API envelope

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: The request builder

Builds the Responses API body. The important behaviour: when we know the lead's website, the search is **pinned to that domain** (`filters.allowed_domains`) — faster and far more accurate than an open search. When we don't, it searches openly.

**Files:**

- Modify: `src/lib/openai/business-research.ts`
- Modify: `tests/business-research.unit.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/business-research.unit.test.ts` (add `buildResearchRequest` to the import at the top):

```ts
describe("buildResearchRequest", () => {
  const inputs = {
    company: "Bella Nails",
    city: "Cicero",
    state: "IL",
    website: null,
    heardOnCall: null,
  };

  function toolOf(req: Record<string, unknown>) {
    return (req.tools as Record<string, unknown>[])[0];
  }

  it("pins the search to the lead's own domain when we have one", () => {
    const req = buildResearchRequest({
      ...inputs,
      website: "https://www.bellanails.com/book",
    });
    expect(toolOf(req).filters).toEqual({
      allowed_domains: ["bellanails.com"],
    });
  });

  it("searches openly when we have no website", () => {
    expect(toolOf(buildResearchRequest(inputs))).not.toHaveProperty("filters");
  });

  it("always requests web search and the strict brief schema", () => {
    const req = buildResearchRequest(inputs);
    expect(toolOf(req).type).toBe("web_search");
    const format = (req.text as { format: Record<string, unknown> }).format;
    expect(format.type).toBe("json_schema");
    expect(format.strict).toBe(true);
    expect(format.name).toBe("front_desk_brief");
  });

  it("puts the business, its location and anything heard on the call in the prompt", () => {
    const req = buildResearchRequest({
      ...inputs,
      heardOnCall: "we mostly do lashes now",
    });
    expect(String(req.input)).toContain("Bella Nails");
    expect(String(req.input)).toContain("Cicero, IL");
    expect(String(req.input)).toContain("we mostly do lashes now");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/business-research.unit.test.ts`
Expected: FAIL — `buildResearchRequest is not exported` / not defined.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/lib/openai/business-research.ts`:

```ts
const MODEL = "gpt-5.4-mini";

/** Strict JSON schema for the brief. `strict: true` requires every property to
 *  be listed in `required` and `additionalProperties: false`. */
const BRIEF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "found",
    "business_name_spoken",
    "what_they_do",
    "services",
    "common_caller_reasons",
    "receptionist_greeting",
    "do_not_claim",
    "source_url",
  ],
  properties: {
    found: {
      type: "boolean",
      description:
        "True ONLY if you are confident you found this exact business. Guessing is worse than false.",
    },
    business_name_spoken: {
      type: "string",
      description: "How a receptionist would say the name out loud.",
    },
    what_they_do: { type: "string", description: "One short sentence." },
    services: {
      type: "array",
      items: { type: "string" },
      description: "Three to five services, each a few words.",
    },
    common_caller_reasons: {
      type: "array",
      items: { type: "string" },
      description: "The three most likely reasons a customer phones them.",
    },
    receptionist_greeting: {
      type: "string",
      description: "The exact line their receptionist would answer with.",
    },
    do_not_claim: {
      type: "array",
      items: { type: "string" },
      description:
        "Anything a receptionist must NOT state because you could not verify it (e.g. prices, hours, staff names).",
    },
    source_url: {
      type: ["string", "null"],
      description: "The page you relied on most.",
    },
  },
} as const;

/** Build the Responses API request. Pure — exported so the domain-pinning logic
 *  is testable without hitting the network. */
export function buildResearchRequest(
  inputs: ResearchInputs,
): Record<string, unknown> {
  const domain = researchDomain(inputs.website);
  const where = [inputs.city, inputs.state]
    .map((s) => s?.trim())
    .filter((s): s is string => Boolean(s))
    .join(", ");
  const heard = inputs.heardOnCall?.trim();

  const instructions = [
    "Research this local business so a receptionist could convincingly answer its phone.",
    `Business: ${inputs.company?.trim() || "(name unknown)"}${where ? ` in ${where}` : ""}.`,
    domain
      ? `Their website is ${domain} — treat it as the primary source.`
      : "Find their website or business listing first.",
    heard
      ? `The owner said this on a live call just now — treat it as authoritative and prefer it over anything on the web: ${heard}`
      : "",
    "If you cannot confirm you found the RIGHT business, set found to false rather than guessing.",
    "Put anything you could not verify into do_not_claim.",
    "Keep every field short enough to say out loud on a phone call.",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    model: MODEL,
    input: instructions,
    tools: [
      {
        type: "web_search",
        // "low" keeps the round-trip short; the caller is waiting on the phone.
        search_context_size: "low",
        // Pinning to their own domain is both faster and more accurate than an
        // open search — this is why populating leads.website pays off.
        ...(domain ? { filters: { allowed_domains: [domain] } } : {}),
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "front_desk_brief",
        strict: true,
        schema: BRIEF_SCHEMA,
      },
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/business-research.unit.test.ts`
Expected: PASS — 25 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/openai/business-research.ts tests/business-research.unit.test.ts
git commit -m "feat(research): responses-api request builder with domain pinning

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: The network call

The only function here that touches the network. Every failure — no key, HTTP error, timeout, unparseable body — returns the fallback brief.

**Files:**

- Modify: `src/lib/openai/business-research.ts`

- [ ] **Step 1: Write the implementation**

Add the import at the top of `src/lib/openai/business-research.ts`, directly below `import "server-only";`:

```ts
import { openAiKey } from "@/lib/openai/live";
```

Append to the end of the file:

```ts
const RESPONSES_API = "https://api.openai.com/v1/responses";

/** Hard ceiling on the research round-trip. The ElevenLabs tool is registered
 *  with a 25s timeout, so we must come back well inside that with room for the
 *  agent to start speaking. */
const RESEARCH_TIMEOUT_MS = 12_000;

/**
 * Research a business and return a brief the agent can role-play from.
 *
 * Live whenever OPENAI_API_KEY is set (same "live when the credential is
 * present" rule the rest of our OpenAI features use — see lib/openai/live).
 * NEVER throws and never rejects: every failure path returns `fallbackBrief`,
 * because the alternative is dead air on a live sales call.
 */
export async function researchBusiness(
  inputs: ResearchInputs,
): Promise<FrontDeskBrief> {
  const apiKey = openAiKey();
  if (!apiKey) return fallbackBrief(inputs);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESEARCH_TIMEOUT_MS);
  try {
    const res = await fetch(RESPONSES_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(buildResearchRequest(inputs)),
      signal: controller.signal,
    });
    if (!res.ok) return fallbackBrief(inputs);

    const text = extractOutputText((await res.json()) as unknown);
    if (!text) return fallbackBrief(inputs);

    try {
      return buildFrontDeskBrief(inputs, JSON.parse(text));
    } catch {
      return fallbackBrief(inputs);
    }
  } catch {
    // Aborted (timeout) or network failure.
    return fallbackBrief(inputs);
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 2: Verify it compiles and the existing tests still pass**

Run: `npx tsc --noEmit`
Expected: no output (success).

Run: `npx vitest run tests/business-research.unit.test.ts`
Expected: PASS — 25 tests, unchanged.

- [ ] **Step 3: Commit**

```bash
git add src/lib/openai/business-research.ts
git commit -m "feat(research): researchBusiness network call with degrade-never-throw

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Prove the research actually works (live)

**This is the task Marija specifically asked for.** An opt-in test that hits the real OpenAI API and prints the real brief for a real business, so research quality can be judged before any agent is built and before any phone call is placed.

It is skipped by default, so `npm run test:unit` stays offline and free.

**Files:**

- Create: `tests/business-research-live.unit.test.ts`

- [ ] **Step 1: Write the live check**

Create `tests/business-research-live.unit.test.ts`:

```ts
import { config } from "dotenv";
import { describe, expect, it } from "vitest";

// Real credentials. ES imports are hoisted above this call, so the module under
// test is imported dynamically inside the test rather than at the top — that
// way the key is definitely in process.env before anything reads it.
config({ path: ".env.local", quiet: true });

/**
 * OPT-IN live check — skipped unless RESEARCH_LIVE=1.
 *
 * This is the only way to judge whether the research is actually good enough to
 * role-play a stranger's front desk, and it needs no phone call, no agent and
 * no deploy. It prints the brief it got so a human can read it.
 *
 *   RESEARCH_LIVE=1 npx vitest run tests/business-research-live.unit.test.ts
 *
 * Override the target with env vars:
 *   RESEARCH_COMPANY, RESEARCH_CITY, RESEARCH_STATE, RESEARCH_WEBSITE
 *
 * It deliberately does NOT assert `found === true`: an honest "I couldn't
 * identify them" is a correct outcome for a business with no web presence, and
 * failing the run for that would train us to ignore it.
 */
const live = process.env.RESEARCH_LIVE === "1";

describe.skipIf(!live)("researchBusiness — LIVE", () => {
  it("returns a complete, speakable brief for a real business", async () => {
    const { researchBusiness } =
      await import("../src/lib/openai/business-research");

    const inputs = {
      company: process.env.RESEARCH_COMPANY ?? "Referrizer",
      city: process.env.RESEARCH_CITY ?? "Fort Lauderdale",
      state: process.env.RESEARCH_STATE ?? "FL",
      website: process.env.RESEARCH_WEBSITE ?? null,
      heardOnCall: null,
    };

    const started = Date.now();
    const brief = await researchBusiness(inputs);
    const tookMs = Date.now() - started;

    console.log(
      `\n--- researchBusiness (${tookMs}ms) ---\n` +
        `${JSON.stringify(inputs)}\n` +
        `${JSON.stringify(brief, null, 2)}\n`,
    );

    // Shape only: every field present and usable, whatever research found.
    expect(typeof brief.found).toBe("boolean");
    expect(brief.business_name_spoken.length).toBeGreaterThan(0);
    expect(brief.receptionist_greeting.length).toBeGreaterThan(0);
    expect(Array.isArray(brief.services)).toBe(true);
    expect(brief.common_caller_reasons.length).toBeGreaterThan(0);
    expect(Array.isArray(brief.do_not_claim)).toBe(true);

    // The whole point is that this is fast enough to sit inside a live call.
    expect(tookMs).toBeLessThan(20_000);
  }, 30_000);
});
```

- [ ] **Step 2: Verify it is skipped by default**

Run: `npx vitest run tests/business-research-live.unit.test.ts`
Expected: PASS with the suite reported as skipped (0 tests run). No network traffic.

- [ ] **Step 3: Run it for real**

Run: `RESEARCH_LIVE=1 npx vitest run tests/business-research-live.unit.test.ts`

> On PowerShell instead of Git Bash: `$env:RESEARCH_LIVE=1; npx vitest run tests/business-research-live.unit.test.ts`

Expected: PASS, with the full brief printed to the console.

**Read the printed brief before continuing.** Then run it at least twice more against businesses like the real lead list — a small local salon or spa with a weak web presence, one with a website (pass `RESEARCH_WEBSITE` to exercise the domain-pinned path), and one deliberately obscure to confirm `found: false` degrades gracefully. Example:

```bash
RESEARCH_LIVE=1 RESEARCH_COMPANY="A Beautiful You Skincare" RESEARCH_CITY="Cicero" RESEARCH_STATE="IL" \
  npx vitest run tests/business-research-live.unit.test.ts
```

Record the observed latency and whether `found` was true for each. If research is consistently unusable, **stop and report back** — the remaining tasks only wire up a capability that has to be good to be worth shipping.

- [ ] **Step 4: Commit**

```bash
git add tests/business-research-live.unit.test.ts
git commit -m "test(research): opt-in live check that prints a real business brief

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Register the tool key

`ToolKey` and `ServerToolKey` are used by exhaustive `Record` types in five places, so TypeScript itself lists the work: add the key, then fix every compile error. Nothing here changes behaviour for an agent that doesn't tick the box.

**Files:**

- Modify: `src/lib/agents/prompt.ts` (`ALL_TOOLS`, `TOOL_LABELS`, `TOOL_BLOCKS`)
- Modify: `src/lib/elevenlabs/tool-webhook.ts` (`SERVER_TOOL_KEYS`)
- Modify: `src/lib/elevenlabs/server-tools.ts` (`TOOL_DESCRIPTIONS`, `bodySchemaFor`, per-tool timeout)
- Modify: `src/app/(app)/settings/agents/agent-wizard.tsx` (`TOOL_HELPERS`)

- [ ] **Step 1: Add the key to `ALL_TOOLS`**

In `src/lib/agents/prompt.ts`, insert `"demo_front_desk"` after `"mark_dnc"`:

```ts
export const ALL_TOOLS = [
  "send_email",
  "send_text",
  "schedule_callback",
  "get_available_times",
  "book_appointment",
  "mark_dnc",
  "demo_front_desk",
  "transfer_to_number",
] as const;
```

- [ ] **Step 2: Run the compiler to list the exhaustive sites**

Run: `npx tsc --noEmit`
Expected: FAIL — errors reporting `demo_front_desk` missing from `TOOL_LABELS`, `TOOL_BLOCKS` (both `src/lib/agents/prompt.ts`) and `TOOL_HELPERS` (`src/app/(app)/settings/agents/agent-wizard.tsx`).

- [ ] **Step 3: Add the label and the prompt block**

In `src/lib/agents/prompt.ts`, add to `TOOL_LABELS` after the `mark_dnc` entry:

```ts
  demo_front_desk: "Front-desk demo research",
```

And add to `TOOL_BLOCKS` after the `mark_dnc` entry:

```ts
  demo_front_desk: `## smiledial_demo_front_desk
**When to use:** ONLY when the instructions above describe a front-desk demo AND the caller has agreed to hear one. Never call it just to answer a question about the product.
**How to use:**
1. Tell them you're pulling their business up — the lookup takes a few seconds.
2. The tool returns a brief. Open with its \`receptionist_greeting\`, and answer as their front desk using \`services\` and \`common_caller_reasons\`.
3. Never state anything listed in \`do_not_claim\` — say you'd have to check on that.
4. If \`found\` is false, keep it general: play the part without naming specific services or prices.`,
```

- [ ] **Step 4: Add the wizard helper text**

In `src/app/(app)/settings/agents/agent-wizard.tsx`, add to `TOOL_HELPERS` after the `mark_dnc` entry:

```ts
  demo_front_desk:
    "Mid-call: looks the lead's business up on the web and returns a brief the agent can use to role-play their own front desk.",
```

- [ ] **Step 5: Add the key to `SERVER_TOOL_KEYS`**

In `src/lib/elevenlabs/tool-webhook.ts`, add `"demo_front_desk"` after `"mark_dnc"`:

```ts
export const SERVER_TOOL_KEYS = [
  "send_email",
  "send_text",
  "schedule_callback",
  "get_available_times",
  "book_appointment",
  "mark_dnc",
  "demo_front_desk",
] as const;
```

Update that constant's doc comment — it currently says "The five custom server tools" and the count is now wrong:

```ts
/** Our custom server tools, in the order the wizard lists them. */
```

- [ ] **Step 6: Add the ElevenLabs-facing description and parameter**

In `src/lib/elevenlabs/server-tools.ts`, add to `TOOL_DESCRIPTIONS` after the `mark_dnc` entry:

```ts
  demo_front_desk:
    "Look up this prospect's business on the web and return a brief you can use to role-play their own front desk. Call this ONLY when your instructions tell you to run a front-desk demo and the caller has agreed to hear one.",
```

Add a case to `bodySchemaFor`, after the `mark_dnc` case:

```ts
    case "demo_front_desk":
      add(
        "heard_on_call",
        "Anything the caller has ALREADY told you about their business — services, who usually answers the phone, why people call them. Leave blank if they haven't said. Do NOT ask them questions to fill this in.",
        false,
      );
      break;
```

- [ ] **Step 7: Give the tool a longer timeout than the rest**

Still in `src/lib/elevenlabs/server-tools.ts`, add above `buildToolConfig`:

```ts
/** Seconds ElevenLabs waits for our webhook before giving up. 20s is ample for
 *  the tools that only touch our own database; demo_front_desk also runs a live
 *  web search, so it gets longer. */
const TOOL_TIMEOUT_SECS: Record<ServerToolKey, number> = {
  send_email: 20,
  send_text: 20,
  schedule_callback: 20,
  get_available_times: 20,
  book_appointment: 20,
  mark_dnc: 20,
  demo_front_desk: 25,
};
```

And in `buildToolConfig`, replace the hardcoded line:

```ts
    response_timeout_secs: 20,
```

with:

```ts
    response_timeout_secs: TOOL_TIMEOUT_SECS[key],
```

- [ ] **Step 8: Fix the comments this change makes stale**

Three file-header comments hardcode "five" and list the tool names. All are now wrong.

In `src/lib/elevenlabs/server-tools.ts`, in the header comment: change
`Register our five custom server tools with ElevenLabs` → `Register our custom server tools with ElevenLabs`,
and `we upsert the five definitions` → `we upsert every definition`.

In `src/lib/elevenlabs/tool-webhook.ts`, in the header comment: change
`Each of our five custom tools (send_email, schedule_callback, get_available_times, book_appointment, mark_dnc) is registered` →
`Each of our custom tools (see SERVER_TOOL_KEYS) is registered`.

In `src/app/api/elevenlabs/tools/[tool]/route.ts`, in the header comment: change
`One route handles all five custom tools (send_email, schedule_callback, get_available_times, book_appointment, mark_dnc), keyed by the [tool]` →
`One route handles every custom tool (see SERVER_TOOL_KEYS), keyed by the [tool]`.

- [ ] **Step 9: Verify the compiler is clean**

Run: `npx tsc --noEmit`
Expected: FAIL with exactly one remaining error — `executeServerTool` in `src/lib/elevenlabs/tool-webhook.ts` has no case for `"demo_front_desk"`. That is Task 9.

- [ ] **Step 10: Commit**

```bash
git add src/lib/agents/prompt.ts src/lib/elevenlabs/server-tools.ts src/lib/elevenlabs/tool-webhook.ts "src/app/api/elevenlabs/tools/[tool]/route.ts" "src/app/(app)/settings/agents/agent-wizard.tsx"
git commit -m "feat(tools): register the demo_front_desk tool key

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: The tool handler

Resolve the lead, research, opportunistically fill `leads.website`, log, return the brief.

**Files:**

- Modify: `src/lib/elevenlabs/tool-webhook.ts`

- [ ] **Step 1: Widen `CallContext` to carry the research inputs**

In `src/lib/elevenlabs/tool-webhook.ts`, add three fields to the `lead` shape in the `CallContext` type, after `business_email`:

```ts
city: string | null;
state: string | null;
website: string | null;
```

And add the columns to the `select` in `resolveCallContext`:

```ts
    .select(
      "id, owner_id, company, business_phone, mobile_phone, owner_phone, business_email, city, state, website, owner_name, manager_name, employee_name, timezone, status",
    )
```

- [ ] **Step 2: Import the research module**

Add to the imports at the top of `src/lib/elevenlabs/tool-webhook.ts`, keeping alphabetical order among the `@/lib` imports:

```ts
import {
  ownSiteOrigin,
  researchBusiness,
} from "@/lib/openai/business-research";
```

- [ ] **Step 3: Add the dispatch case**

In `executeServerTool`, add after the `mark_dnc` case:

```ts
    case "demo_front_desk":
      return demoFrontDesk(ctx, body);
```

- [ ] **Step 4: Write the handler**

Append to the end of `src/lib/elevenlabs/tool-webhook.ts`:

```ts
// ---------------------------------------------------------------------------
// demo_front_desk
// ---------------------------------------------------------------------------
/**
 * Research the lead's business live so the agent can role-play their own front
 * desk. Returns the brief alongside a speakable `message`; the agent's own
 * prompt decides how the demo is performed.
 *
 * Always succeeds. When research finds nothing the brief is still complete and
 * the message tells the agent to keep the demo general — a stalled tool call
 * mid-conversation is far worse than a vague demo.
 */
async function demoFrontDesk(
  ctx: CallContext,
  body: Record<string, unknown>,
): Promise<ToolWebhookResult> {
  const startedAt = Date.now();

  const brief = await researchBusiness({
    company: ctx.lead.company,
    city: ctx.lead.city,
    state: ctx.lead.state,
    website: ctx.lead.website,
    heardOnCall: str(body.heard_on_call) || null,
  });

  // Free enrichment: essentially no lead has a website today, and that column
  // is what pins the NEXT research run. Only ever fill a blank — never
  // overwrite (the same rule sendEmail follows for business_email) — and only
  // with the business's OWN site, never a directory listing.
  const discovered = ctx.lead.website ? null : ownSiteOrigin(brief.source_url);
  if (discovered) {
    await ctx.supabase
      .from("leads")
      .update({ website: discovered })
      .eq("id", ctx.lead.id);
  }

  await logToolEvent(ctx, "tool_demo_front_desk", {
    found: brief.found,
    source_url: brief.source_url,
    website_captured: discovered,
    took_ms: Date.now() - startedAt,
  });

  return {
    success: true,
    message: brief.found
      ? "I've got their details — use this brief to play their front desk."
      : "I couldn't confirm much about them online — keep the demo general and don't state any specifics.",
    brief,
  };
}
```

- [ ] **Step 5: Verify the compiler is clean**

Run: `npx tsc --noEmit`
Expected: no output (success).

Run: `npx vitest run`
Expected: PASS — all unit suites, with the live suite skipped.

- [ ] **Step 6: Commit**

```bash
git add src/lib/elevenlabs/tool-webhook.ts
git commit -m "feat(tools): demo_front_desk handler with opportunistic website capture

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: Endpoint contract test

Playwright drives the real HTTP endpoint against a seeded lead.

Two things to know about what this test actually exercises. Without an OpenAI key it takes the **degraded path** — the one that must never break. **With** a key (as on a deployed preview) it performs a real web search for the seeded fake company name, which costs one OpenAI call and roughly 10 seconds, and will legitimately return `found: false`. That is why every assertion below is on the brief's **shape**, never on `found`.

**Files:**

- Modify: `tests/elevenlabs-tools.spec.ts`

- [ ] **Step 1: Write the test**

Add to `tests/elevenlabs-tools.spec.ts`, alongside the other `test(...)` blocks inside the `test.describe` (the `post`, `seedLeadAndCall`, `cleanupLeadAndCall` and `admin` helpers are already defined in that file):

```ts
test("demo_front_desk returns a complete brief and logs the lookup", async () => {
  const { leadId, callId } = await seedLeadAndCall();
  try {
    const { status, body } = await post("demo_front_desk", {
      call_id: callId,
      heard_on_call: "we mostly do gel manicures",
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    // Every field must be present and speakable even with no research
    // available — the agent is mid-conversation and cannot handle a gap.
    const brief = body.brief;
    expect(typeof brief.found).toBe("boolean");
    expect(String(brief.business_name_spoken).length).toBeGreaterThan(0);
    expect(String(brief.receptionist_greeting).length).toBeGreaterThan(0);
    expect(Array.isArray(brief.services)).toBe(true);
    expect(brief.common_caller_reasons.length).toBeGreaterThan(0);
    expect(Array.isArray(brief.do_not_claim)).toBe(true);

    const { data: event } = await admin
      .from("system_events")
      .select("kind, ref_id, payload")
      .eq("ref_id", callId)
      .eq("kind", "tool_demo_front_desk")
      .single();
    expect(event?.ref_id).toBe(callId);
    expect(event?.payload).toHaveProperty("took_ms");
  } finally {
    await cleanupLeadAndCall(leadId, callId);
  }
});

test("demo_front_desk degrades gracefully when the call can't be resolved", async () => {
  const { status, body } = await post("demo_front_desk", {
    call_id: "00000000-0000-0000-0000-000000000000",
  });
  expect(status).toBe(200);
  expect(body.success).toBe(false);
});
```

- [ ] **Step 2: Verify it type-checks and lints**

Run: `npx tsc --noEmit`
Expected: no output (success).

Run: `npx eslint tests/elevenlabs-tools.spec.ts`
Expected: no output (success).

> These specs run against a live environment and cannot be executed here. Type-check and lint are the gate; the suite is the contract for whoever runs it against a deployed preview.

- [ ] **Step 3: Commit**

```bash
git add tests/elevenlabs-tools.spec.ts
git commit -m "test(tools): endpoint contract for demo_front_desk

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 11: Full verification and PR

**Files:** none modified.

- [ ] **Step 1: Type-check the whole project**

Run: `npx tsc --noEmit`
Expected: no output (success).

- [ ] **Step 2: Lint every changed file**

Run:

```bash
npx eslint src/lib/openai/business-research.ts src/lib/agents/prompt.ts src/lib/elevenlabs/server-tools.ts src/lib/elevenlabs/tool-webhook.ts "src/app/(app)/settings/agents/agent-wizard.tsx" tests/business-research.unit.test.ts tests/business-research-live.unit.test.ts tests/elevenlabs-tools.spec.ts
```

Expected: no output (success).

- [ ] **Step 3: Run the offline unit suite**

Run: `npm run test:unit`
Expected: PASS — every suite, live suite skipped.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: build completes with no errors.

- [ ] **Step 5: Confirm no migration crept in**

Run: `git diff main --stat -- supabase`
Expected: empty output. This change must not touch the database schema.

- [ ] **Step 6: Push and open the PR**

```bash
git push -u origin feat/live-front-desk-demo
gh pr create --title "feat(tools): front-desk demo research tool" --body "$(cat <<'EOF'
Adds a seventh ElevenLabs server tool, `demo_front_desk`. Mid-call it looks the
prospect's business up on the web and returns a short, speakable brief the agent
can use to role-play their own front desk — the sales moment for prospects who
can't picture an AI answering their phone.

**Scope is the tool only.** How a demo is actually performed — the persona, a
second voice, when to offer it — is per-agent setup on a purpose-built demo
agent in the ElevenLabs dashboard. Nothing here changes any existing agent's
behaviour.

## What's in it
- `src/lib/openai/business-research.ts` — OpenAI Responses API + `web_search`
  with a strict JSON schema. Pins the search to the lead's own domain when we
  have one. Every failure path (no key, HTTP error, 12s timeout, junk response)
  degrades to a complete generic brief rather than stalling a live call.
- Handler in the existing tool-webhook dispatcher: researches, opportunistically
  fills `leads.website` when it finds the business's own site (never a directory
  listing, never overwriting an existing value), and logs to `system_events`.
- The tool key added to the five exhaustive `ToolKey`/`ServerToolKey` sites,
  which gives the wizard checkbox and connected-agent sync for free.
- `response_timeout_secs` becomes per-tool so this one gets 25s while the rest
  stay at 20s.

## Notes
- **No database migration.** Nothing here touches schema.
- First use of OpenAI's `/v1/responses` in this repo; everything else uses
  `/v1/chat/completions`.
- An unchecked tool is never attached to an agent, so this is inert until
  someone ticks the box.

## Verification
- `npx tsc --noEmit`, `npx eslint <changed files>`, `npm run build` — clean.
- `npm run test:unit` — 25 offline unit tests over the pure research functions.
- Live research check (opt-in, prints a real brief for a real business):
  `RESEARCH_LIVE=1 npx vitest run tests/business-research-live.unit.test.ts`
- Playwright contract added to `tests/elevenlabs-tools.spec.ts` (runs against a
  live environment; type-checked and linted here).

Design: `docs/superpowers/specs/2026-07-21-live-front-desk-demo-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 7: Report back before merging**

Do not merge. Report to Marija:

- the live research results from Task 7 — latency and `found` rate per business tried, and the actual briefs;
- confirmation that tsc / eslint / build / unit tests are clean;
- the PR link.

---

## What is deliberately NOT in this plan

Per the design spec, these are per-agent setup done in the ElevenLabs dashboard by whoever builds a demo agent, not code:

- the demo persona, the offer/exit rules, honouring `do_not_claim`;
- the second voice and the `<LABEL>` switch markup;
- raising `max_soft_timeouts_per_generation` so the agent fills the research wait;
- the prompt rule that the role-played receptionist never gives a personal name (which is what keeps role-play out of post-call `owner_name` extraction);
- any Call Reviewer handling of demo calls.

Also out of scope: research caching, provisioning a real front desk for the prospect, per-lead ElevenLabs agents, and pre-researching the lead database.
