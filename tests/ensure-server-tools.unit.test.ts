import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { ToolConfig } from "@/lib/elevenlabs/tool-config-merge";

/**
 * ensureServerTools drives the real ElevenLabs workspace sync. These tests
 * stub global fetch and mock its two dependency modules so the real function
 * runs end to end, exercising the branch this PR changed — merge into a live
 * tool instead of overwriting it — and two ways that branch could still lose
 * Marija's dashboard settings: a list call that fails (FIX A) and a live
 * config that arrives with no api_schema (FIX B).
 *
 * ensureServerTools caches its resolution in a module-level variable, so
 * every run (see `run()` below) re-imports the module fresh
 * (vi.resetModules() + a dynamic import) rather than sharing one instance —
 * otherwise one test's cache would leak into the next.
 *
 * The "live" fixture is never hand-copied from server-tools.ts: it's built by
 * first running ensureServerTools against an EMPTY workspace and capturing
 * the real POST bodies (buildToolConfig's actual output — today's
 * descriptions, URLs and per-tool schemas), then reshaping those into what
 * GET /v1/convai/tools actually returns: every parameter echoed back with
 * ElevenLabs' extra defaults, plus the dashboard's run-time settings Marija
 * set live on 2026-09-11 (shape verified against a redacted real dump). That
 * way this fixture can't quietly drift from the code it exercises.
 */

vi.mock("@/lib/elevenlabs/tool-webhook", () => ({
  SERVER_TOOL_KEYS: [
    "send_email",
    "send_text",
    "schedule_callback",
    "get_available_times",
    "book_appointment",
    "mark_dnc",
    "demo_front_desk",
  ],
  getToolWebhookSecret: async () => "test-tool-secret",
}));
vi.mock("@/lib/agents/prompt", () => ({
  SERVER_TOOL_FUNCTION_PREFIX: "smiledial_",
}));

const PREFIX = "smiledial_";
const KEYS = [
  "send_email",
  "send_text",
  "schedule_callback",
  "get_available_times",
  "book_appointment",
  "mark_dnc",
  "demo_front_desk",
] as const;

type WireEntry = { id: string; tool_config: ToolConfig };

/** ElevenLabs echoes every parameter back with extra defaults, and always
 *  sends all three of description/dynamic_variable/constant_value (empty
 *  when unset) — keeps whichever one `def` (ours) actually set. */
function liveParam(def: Record<string, unknown>): Record<string, unknown> {
  return {
    type: def.type,
    description: typeof def.description === "string" ? def.description : "",
    enum: null,
    is_system_provided: false,
    dynamic_variable:
      typeof def.dynamic_variable === "string" ? def.dynamic_variable : "",
    allowed_values: null,
    allowed_values_dynamic_variable: "",
    constant_value:
      typeof def.constant_value === "string" ? def.constant_value : "",
    is_omitted: false,
  };
}

type DashboardSettings = {
  executionMode: string;
  preToolSpeech: string;
  interruptionMode: string;
  timeoutSecs: number;
};

/** Marija's live 2026-09-11 dashboard choices, per tool (from a redacted
 *  workspace dump). ownedFieldsDiffer never looks at these fields — they're
 *  here only so the "nothing to do" fixture looks like a real synced
 *  workspace, not a rebuild of our own creation defaults. */
const DASHBOARD: Record<(typeof KEYS)[number], DashboardSettings> = {
  send_email: {
    executionMode: "async",
    preToolSpeech: "auto",
    interruptionMode: "allow",
    timeoutSecs: 20,
  },
  send_text: {
    executionMode: "async",
    preToolSpeech: "auto",
    interruptionMode: "allow",
    timeoutSecs: 20,
  },
  schedule_callback: {
    executionMode: "async",
    preToolSpeech: "auto",
    interruptionMode: "disable_during_tool",
    timeoutSecs: 20,
  },
  get_available_times: {
    executionMode: "immediate",
    preToolSpeech: "force",
    interruptionMode: "disable_during_tool_and_turn",
    timeoutSecs: 20,
  },
  book_appointment: {
    executionMode: "immediate",
    preToolSpeech: "force",
    interruptionMode: "disable_during_tool",
    timeoutSecs: 20,
  },
  mark_dnc: {
    executionMode: "async",
    preToolSpeech: "auto",
    interruptionMode: "disable_during_tool",
    timeoutSecs: 20,
  },
  demo_front_desk: {
    executionMode: "immediate",
    preToolSpeech: "auto",
    interruptionMode: "allow",
    timeoutSecs: 25,
  },
};

/** Reshape one of OUR built configs (buildToolConfig's real output) into the
 *  shape GET /v1/convai/tools returns for an existing tool: the same
 *  code-owned fields (type/name/description/api_schema, every parameter
 *  echoed with ElevenLabs' extra defaults), plus the dashboard's run-time
 *  settings layered on top. */
function toLiveShape(
  id: string,
  ours: ToolConfig,
  dashboard: DashboardSettings,
): WireEntry {
  const api = ours.api_schema as Record<string, unknown>;
  const body = api.request_body_schema as {
    type: string;
    description: string;
    required: string[];
    properties: Record<string, Record<string, unknown>>;
  };
  const properties: Record<string, Record<string, unknown>> = {};
  for (const [name, def] of Object.entries(body.properties)) {
    properties[name] = liveParam(def);
  }
  return {
    id,
    tool_config: {
      type: ours.type,
      name: ours.name,
      description: ours.description,
      response_timeout_secs: dashboard.timeoutSecs,
      disable_interruptions: dashboard.interruptionMode !== "allow",
      interruption_mode: dashboard.interruptionMode,
      force_pre_tool_speech: dashboard.preToolSpeech === "force",
      pre_tool_speech: dashboard.preToolSpeech,
      assignments: [],
      tool_call_sound: null,
      tool_call_sound_behavior: "auto",
      tool_error_handling_mode: "auto",
      dynamic_variables: { dynamic_variable_placeholders: {} },
      execution_mode: dashboard.executionMode,
      api_schema: {
        request_headers: {},
        kind: "webhook",
        url: api.url,
        method: api.method,
        path_params_schema: {},
        query_params_schema: null,
        request_body_schema: {
          description: body.description,
          dynamic_variable: "",
          is_omitted: false,
          type: body.type,
          required: body.required,
          properties,
        },
        response_body_schema: null,
        response_filter: null,
        content_type: "application/json",
        auth_resolved_params: [],
        auth_connection: null,
      },
      follow_redirects: false,
      follow_redirects_allowed_domains: [],
    },
  };
}

/** Run ensureServerTools once against an EMPTY workspace (every tool takes
 *  the create/POST path) and capture each POST's tool_config, keyed by name —
 *  i.e. buildToolConfig's real, current output for all 7 tools. */
async function captureBuiltConfigs(): Promise<Record<string, ToolConfig>> {
  const built: Record<string, ToolConfig> = {};
  vi.resetModules();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return new Response(JSON.stringify({ tools: [], has_more: false }));
      }
      const body = JSON.parse(String(init!.body)).tool_config as ToolConfig;
      built[String(body.name)] = body;
      return new Response(JSON.stringify({ id: `seed_${String(body.name)}` }));
    }),
  );
  const mod = await import("@/lib/elevenlabs/server-tools");
  await mod.ensureServerTools();
  vi.unstubAllGlobals();
  return built;
}

async function buildMatchingLiveTools(): Promise<WireEntry[]> {
  const built = await captureBuiltConfigs();
  return KEYS.map((key) =>
    toLiveShape(`existing_${key}`, built[`${PREFIX}${key}`], DASHBOARD[key]),
  );
}

type Scenario = {
  /** GET /v1/convai/tools pages, in order. Default: one page, no tools. */
  pages?: WireEntry[][];
  /** >=400 makes every GET fail with this status (FIX A). */
  listStatus?: number;
  /** Makes every GET throw instead of resolving (FIX A's other failure mode). */
  listThrows?: boolean;
  patchStatus?: number;
  postStatus?: number;
};

/** One full ensureServerTools run against a stubbed workspace, on a FRESH
 *  module instance (so the module-level id cache never leaks between tests) —
 *  then a second call on that SAME instance, to see what the cache does. */
async function run(scenario: Scenario) {
  vi.resetModules();
  const calls: string[] = [];
  const patchBodies: ToolConfig[] = [];
  const postBodies: ToolConfig[] = [];
  let page = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push(
        `${method} ${String(url).replace(/^https:\/\/api\.elevenlabs\.io/, "")}`,
      );
      if (method === "GET") {
        if (scenario.listThrows) throw new Error("simulated network failure");
        if (scenario.listStatus && scenario.listStatus >= 400) {
          return new Response("boom", { status: scenario.listStatus });
        }
        const pages = scenario.pages ?? [[]];
        const tools = pages[Math.min(page, pages.length - 1)];
        const more = page < pages.length - 1;
        page += 1;
        return new Response(
          JSON.stringify({
            tools,
            has_more: more,
            next_cursor: more ? `c${page}` : null,
          }),
        );
      }
      if (method === "PATCH") {
        const body = JSON.parse(String(init!.body)).tool_config as ToolConfig;
        patchBodies.push(body);
        return new Response("{}", { status: scenario.patchStatus ?? 200 });
      }
      const body = JSON.parse(String(init!.body)).tool_config as ToolConfig;
      postBodies.push(body);
      return new Response(JSON.stringify({ id: `new_${String(body.name)}` }), {
        status: scenario.postStatus ?? 200,
      });
    }),
  );
  const mod = await import("@/lib/elevenlabs/server-tools");
  const out = await mod.ensureServerTools();
  const callsAfterFirst = [...calls];
  const out2 = await mod.ensureServerTools();
  const callsAfterSecond = [...calls];
  return {
    out,
    out2,
    callsAfterFirst,
    callsAfterSecond,
    patchBodies,
    postBodies,
  };
}

const ENV_KEYS = [
  "ELEVENLABS_LIVE",
  "ELEVENLABS_API_KEY",
  "VERCEL_ENV",
  "NEXT_PUBLIC_APP_URL",
] as const;
const ORIGINAL_ENV: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
for (const k of ENV_KEYS) ORIGINAL_ENV[k] = process.env[k];

/** isLive() true, appBaseUrl() resolved to the canonical domain (VERCEL_ENV
 *  production, no override needed), an API key present. */
function setLiveEnv() {
  process.env.ELEVENLABS_LIVE = "live";
  process.env.ELEVENLABS_API_KEY = "test-key";
  process.env.VERCEL_ENV = "production";
  delete process.env.NEXT_PUBLIC_APP_URL;
}

let matchingLiveTools: WireEntry[];
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  setLiveEnv();
  matchingLiveTools = await buildMatchingLiveTools();
});

beforeEach(() => {
  setLiveEnv();
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    const original = ORIGINAL_ENV[k];
    if (original === undefined) delete process.env[k];
    else process.env[k] = original;
  }
});

describe("ensureServerTools (live ElevenLabs sync, fetch stubbed)", () => {
  it("leaves already-matching tools untouched: one GET, zero writes, all 7 ids, second call cached", async () => {
    const {
      out,
      out2,
      callsAfterFirst,
      callsAfterSecond,
      patchBodies,
      postBodies,
    } = await run({ pages: [structuredClone(matchingLiveTools)] });

    expect(callsAfterFirst).toEqual(["GET /v1/convai/tools"]);
    expect(patchBodies).toHaveLength(0);
    expect(postBodies).toHaveLength(0);
    expect(Object.keys(out)).toHaveLength(7);
    for (const key of KEYS) expect(out[key]).toBe(`existing_${key}`);

    // Nothing changed, so a second call in the same process is fully cached.
    expect(callsAfterSecond).toEqual(callsAfterFirst);
    expect(out2).toEqual(out);
  });

  it("creates a tool missing from the workspace: exactly one POST, all 7 ids", async () => {
    const pages = [
      structuredClone(matchingLiveTools).filter(
        (t) => t.tool_config.name !== `${PREFIX}book_appointment`,
      ),
    ];
    const { out, callsAfterFirst, patchBodies, postBodies } = await run({
      pages,
    });

    expect(callsAfterFirst).toHaveLength(2); // 1 GET + 1 POST
    expect(postBodies).toHaveLength(1);
    expect(postBodies[0].name).toBe(`${PREFIX}book_appointment`);
    expect(patchBodies).toHaveLength(0);
    expect(Object.keys(out)).toHaveLength(7);
    expect(out.book_appointment).toBe(`new_${PREFIX}book_appointment`);
  });

  it("keeps the id when a PATCH fails (500)", async () => {
    const pages = [structuredClone(matchingLiveTools)];
    const stale = pages[0].find(
      (t) => t.tool_config.name === `${PREFIX}mark_dnc`,
    )!;
    stale.tool_config.description =
      "Stale description the code no longer sends.";

    const { out, callsAfterFirst, patchBodies, postBodies } = await run({
      pages,
      patchStatus: 500,
    });

    expect(callsAfterFirst).toHaveLength(2); // 1 GET + 1 PATCH
    expect(patchBodies).toHaveLength(1);
    expect(postBodies).toHaveLength(0);
    expect(out.mark_dnc).toBe("existing_mark_dnc");
    expect(
      consoleErrorSpy.mock.calls.some((c: unknown[]) =>
        String(c[0]).includes(`PATCH ${PREFIX}mark_dnc failed`),
      ),
    ).toBe(true);
  });

  it("does not cache an incomplete resolution: a failed create means the next call hits the network again", async () => {
    const pages = [
      structuredClone(matchingLiveTools).filter(
        (t) => t.tool_config.name !== `${PREFIX}book_appointment`,
      ),
    ];
    const { out, callsAfterFirst, callsAfterSecond } = await run({
      pages,
      postStatus: 500,
    });

    expect(Object.keys(out)).toHaveLength(6);
    expect(out.book_appointment).toBeUndefined();
    expect(callsAfterSecond.length).toBeGreaterThan(callsAfterFirst.length);
  });

  describe("FIX A: the list call itself is unreadable", () => {
    it("a 500 from GET /v1/convai/tools returns {}, touches no tool, and retries next time", async () => {
      const {
        out,
        out2,
        callsAfterFirst,
        callsAfterSecond,
        patchBodies,
        postBodies,
      } = await run({ listStatus: 500 });

      expect(callsAfterFirst).toEqual(["GET /v1/convai/tools"]);
      expect(patchBodies).toHaveLength(0);
      expect(postBodies).toHaveLength(0);
      expect(out).toEqual({});
      expect(
        consoleErrorSpy.mock.calls.some((c: unknown[]) =>
          String(c[0]).includes("could not list workspace tools"),
        ),
      ).toBe(true);

      // Nothing cached: the second call retries the list too.
      expect(callsAfterSecond.length).toBeGreaterThan(callsAfterFirst.length);
      expect(out2).toEqual({});
    });

    it("a thrown fetch (network failure) is caught the same way, not left to crash the sync", async () => {
      const { out, callsAfterFirst, patchBodies, postBodies } = await run({
        listThrows: true,
      });

      expect(out).toEqual({});
      expect(patchBodies).toHaveLength(0);
      expect(postBodies).toHaveLength(0);
      expect(callsAfterFirst).toEqual(["GET /v1/convai/tools"]);
      expect(
        consoleErrorSpy.mock.calls.some((c: unknown[]) =>
          String(c[0]).includes("could not list workspace tools"),
        ),
      ).toBe(true);
    });
  });

  describe("FIX B: a live tool_config with no api_schema", () => {
    it("is left alone (no PATCH), its id is still returned, and the skip is logged", async () => {
      const pages = [structuredClone(matchingLiveTools)];
      const thin = pages[0].find(
        (t) => t.tool_config.name === `${PREFIX}send_email`,
      )!;
      thin.tool_config = { name: `${PREFIX}send_email` };

      const { out, patchBodies, postBodies } = await run({ pages });

      expect(patchBodies).toHaveLength(0);
      expect(postBodies).toHaveLength(0);
      expect(out.send_email).toBe("existing_send_email");
      expect(Object.keys(out)).toHaveLength(7);
      expect(
        consoleErrorSpy.mock.calls.some((c: unknown[]) =>
          String(c[0]).includes(
            `${PREFIX}send_email: live config has no api_schema`,
          ),
        ),
      ).toBe(true);
    });
  });
});
