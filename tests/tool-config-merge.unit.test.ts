import { describe, expect, it } from "vitest";

import {
  CODE_OWNED_TOOL_FIELDS,
  mergeToolConfig,
  ownedFieldsDiffer,
  type ToolConfig,
} from "../src/lib/elevenlabs/tool-config-merge";

/**
 * Fixtures are shaped like REAL ElevenLabs responses (GET /v1/convai/tools,
 * read 2026-09-11): every parameter comes back with extra defaults
 * (is_system_provided, allowed_values, …) and empty strings for the fields we
 * didn't set, and the config carries dashboard settings our code never sends.
 */
const SECRET = "s3cret";
const URL_BASE = "https://www.smile-and-dial.com/api/elevenlabs/tools";

function liveParam(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "string",
    description: "",
    enum: null,
    is_system_provided: false,
    dynamic_variable: "",
    allowed_values: null,
    allowed_values_dynamic_variable: "",
    constant_value: "",
    is_omitted: false,
    ...extra,
  };
}

/** The live smiledial_schedule_callback as ElevenLabs returns it, with
 *  Marija's dashboard choices (background mode) in place. */
function liveTool(): ToolConfig {
  return {
    type: "webhook",
    name: "smiledial_schedule_callback",
    description: "Schedule a callback for the lead.",
    response_timeout_secs: 20,
    disable_interruptions: true,
    interruption_mode: "disable_during_tool",
    force_pre_tool_speech: false,
    pre_tool_speech: "auto",
    assignments: [],
    tool_call_sound: null,
    tool_call_sound_behavior: "auto",
    tool_error_handling_mode: "auto",
    dynamic_variables: { dynamic_variable_placeholders: {} },
    execution_mode: "async",
    follow_redirects: false,
    follow_redirects_allowed_domains: [],
    api_schema: {
      request_headers: {},
      kind: "http",
      url: `${URL_BASE}/schedule_callback`,
      method: "POST",
      path_params_schema: {},
      query_params_schema: null,
      request_body_schema: {
        description: "Parameters for the schedule_callback tool.",
        dynamic_variable: "",
        is_omitted: false,
        type: "object",
        required: ["call_id", "tool_secret", "callback_datetime"],
        properties: {
          call_id: liveParam({ dynamic_variable: "call_id" }),
          tool_secret: liveParam({ constant_value: SECRET }),
          callback_datetime: liveParam({ description: "The requested time." }),
          note: liveParam({ description: "Optional note." }),
        },
      },
      response_body_schema: null,
      response_filter: null,
      content_type: "application/json",
      auth_resolved_params: null,
      auth_connection: null,
    },
  };
}

/** What buildToolConfig in server-tools.ts produces for the same tool. Its
 *  run-time settings deliberately DISAGREE with the live ones, the way the old
 *  code's did. */
function ourTool(): ToolConfig {
  return {
    type: "webhook",
    name: "smiledial_schedule_callback",
    description: "Schedule a callback for the lead.",
    response_timeout_secs: 20,
    interruption_mode: "disable_during_tool",
    pre_tool_speech: "auto",
    execution_mode: "immediate",
    api_schema: {
      url: `${URL_BASE}/schedule_callback`,
      method: "POST",
      path_params_schema: {},
      query_params_schema: null,
      request_headers: {},
      request_body_schema: {
        type: "object",
        description: "Parameters for the schedule_callback tool.",
        required: ["call_id", "tool_secret", "callback_datetime"],
        properties: {
          call_id: { type: "string", enum: null, dynamic_variable: "call_id" },
          tool_secret: { type: "string", enum: null, constant_value: SECRET },
          callback_datetime: {
            type: "string",
            enum: null,
            description: "The requested time.",
          },
          note: { type: "string", enum: null, description: "Optional note." },
        },
      },
    },
  };
}

/** Deep-clone + edit helper for the api_schema's body. */
function withBody(
  tool: ToolConfig,
  edit: (body: {
    required: string[];
    properties: Record<string, Record<string, unknown>>;
  }) => void,
): ToolConfig {
  const copy = structuredClone(tool);
  const api = copy.api_schema as Record<string, unknown>;
  edit(
    api.request_body_schema as {
      required: string[];
      properties: Record<string, Record<string, unknown>>;
    },
  );
  return copy;
}

describe("CODE_OWNED_TOOL_FIELDS", () => {
  it("is exactly the plumbing: type, name, description, api_schema", () => {
    expect([...CODE_OWNED_TOOL_FIELDS]).toEqual([
      "type",
      "name",
      "description",
      "api_schema",
    ]);
  });
});

describe("mergeToolConfig: the dashboard owns how a tool runs", () => {
  it("keeps the dashboard's background mode and every other run-time setting", () => {
    const live = {
      ...liveTool(),
      execution_mode: "async",
      pre_tool_speech: "force",
      force_pre_tool_speech: true,
      tool_call_sound: "typing",
      response_timeout_secs: 30,
    };
    const merged = mergeToolConfig(live, ourTool());
    expect(merged.execution_mode).toBe("async");
    expect(merged.pre_tool_speech).toBe("force");
    expect(merged.force_pre_tool_speech).toBe(true);
    expect(merged.tool_call_sound).toBe("typing");
    expect(merged.response_timeout_secs).toBe(30);
    expect(merged.interruption_mode).toBe("disable_during_tool");
  });

  it("replaces the four code-owned fields with ours", () => {
    const ours = {
      ...ourTool(),
      description: "A new description.",
      api_schema: {
        ...(ourTool().api_schema as Record<string, unknown>),
        url: `${URL_BASE}/schedule_callback_v2`,
      },
    };
    const merged = mergeToolConfig(liveTool(), ours);
    expect(merged.description).toBe("A new description.");
    expect((merged.api_schema as Record<string, unknown>).url).toBe(
      `${URL_BASE}/schedule_callback_v2`,
    );
    expect(merged.type).toBe("webhook");
    expect(merged.name).toBe("smiledial_schedule_callback");
  });

  it("keeps settings ElevenLabs adds in future that our code has never heard of", () => {
    const live = { ...liveTool(), some_future_setting: { level: 3 } };
    expect(mergeToolConfig(live, ourTool()).some_future_setting).toEqual({
      level: 3,
    });
  });

  it("never mutates its inputs", () => {
    const live = liveTool();
    const ours = ourTool();
    const liveBefore = structuredClone(live);
    const oursBefore = structuredClone(ours);
    mergeToolConfig(live, ours);
    expect(live).toEqual(liveBefore);
    expect(ours).toEqual(oursBefore);
  });
});

describe("ownedFieldsDiffer: does a re-sync need to touch this tool at all?", () => {
  it("is false when the live plumbing already matches, despite ElevenLabs' extra defaults and different run-time settings", () => {
    expect(ownedFieldsDiffer(liveTool(), ourTool())).toBe(false);
  });

  it("is true when code added a parameter (e.g. #522's `mobile`)", () => {
    const ours = withBody(ourTool(), (b) => {
      b.properties.mobile = {
        type: "string",
        enum: null,
        description: "Their cell.",
      };
    });
    expect(ownedFieldsDiffer(liveTool(), ours)).toBe(true);
  });

  it("is true when code removed a parameter that is still live", () => {
    const ours = withBody(ourTool(), (b) => {
      delete b.properties.note;
    });
    expect(ownedFieldsDiffer(liveTool(), ours)).toBe(true);
  });

  it("is true when the shared secret changed", () => {
    const ours = withBody(ourTool(), (b) => {
      b.properties.tool_secret = {
        type: "string",
        enum: null,
        constant_value: "rotated",
      };
    });
    expect(ownedFieldsDiffer(liveTool(), ours)).toBe(true);
  });

  it("is true when a parameter's wording changed", () => {
    const ours = withBody(ourTool(), (b) => {
      b.properties.callback_datetime = {
        type: "string",
        enum: null,
        description: "Reworded.",
      };
    });
    expect(ownedFieldsDiffer(liveTool(), ours)).toBe(true);
  });

  it("is true when the required list changed, but not when only its order did", () => {
    const added = withBody(ourTool(), (b) => {
      b.required = [...b.required, "note"];
    });
    expect(ownedFieldsDiffer(liveTool(), added)).toBe(true);

    const reordered = withBody(ourTool(), (b) => {
      b.required = [...b.required].reverse();
    });
    expect(ownedFieldsDiffer(liveTool(), reordered)).toBe(false);
  });

  it("is true when the URL, method, name or description changed", () => {
    const api = ourTool().api_schema as Record<string, unknown>;
    expect(
      ownedFieldsDiffer(liveTool(), {
        ...ourTool(),
        api_schema: { ...api, url: `${URL_BASE}/other` },
      }),
    ).toBe(true);
    expect(
      ownedFieldsDiffer(liveTool(), {
        ...ourTool(),
        api_schema: { ...api, method: "GET" },
      }),
    ).toBe(true);
    expect(
      ownedFieldsDiffer(liveTool(), { ...ourTool(), name: "smiledial_x" }),
    ).toBe(true);
    expect(
      ownedFieldsDiffer(liveTool(), { ...ourTool(), description: "Changed." }),
    ).toBe(true);
  });

  it("treats null and a missing key as the same", () => {
    const live = withBody(liveTool(), (b) => {
      delete b.properties.note.enum;
    });
    expect(ownedFieldsDiffer(live, ourTool())).toBe(false);
  });

  it("ignores every dashboard-owned setting", () => {
    const live = {
      ...liveTool(),
      execution_mode: "post_tool_speech",
      pre_tool_speech: "off",
      interruption_mode: "allow",
      tool_call_sound: "elevator2",
      response_timeout_secs: 45,
    };
    expect(ownedFieldsDiffer(live, ourTool())).toBe(false);
  });
});
