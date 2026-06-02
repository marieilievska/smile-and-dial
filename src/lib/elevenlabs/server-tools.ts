import "server-only";

import {
  getToolWebhookSecret,
  SERVER_TOOL_KEYS,
  type ServerToolKey,
} from "@/lib/elevenlabs/tool-webhook";
import {
  SERVER_TOOL_FUNCTION_PREFIX,
  type ToolsEnabled,
} from "@/lib/agents/prompt";
import { appBaseUrl } from "@/lib/app-url";

/**
 * Register our five custom server tools with ElevenLabs and map each to the
 * workspace tool id the agent references via `tool_ids`.
 *
 * ElevenLabs tools are WORKSPACE-level objects (POST /v1/convai/tools),
 * reusable across agents. We keep exactly one tool per key, matched by
 * `tool_config.name` (which must equal the key so the agent prompt's tool
 * instructions line up with the function the LLM sees). On each sync we
 * upsert the five definitions, then attach the enabled subset's ids to the
 * agent.
 *
 * Everything here is mocked unless ELEVENLABS_LIVE=live, so tests and local
 * dev never hit the network and never need an app URL or secret.
 */

const TOOLS_API = "https://api.elevenlabs.io/v1/convai/tools";

function isLive(): boolean {
  return process.env.ELEVENLABS_LIVE === "live";
}

/** The ElevenLabs (LLM-facing) function name for one of our tool keys.
 *  Namespaced so we never collide with the shared workspace's other tools. */
function toolFunctionName(key: ServerToolKey): string {
  return `${SERVER_TOOL_FUNCTION_PREFIX}${key}`;
}

const TOOL_DESCRIPTIONS: Record<ServerToolKey, string> = {
  send_email:
    "Send the lead the information they asked for by email. Confirm the email address with the caller first.",
  schedule_callback:
    "Schedule a callback for the lead at a specific date and time they request.",
  get_available_times:
    "Get available appointment times to offer the lead. Returns a list of slots, each with a slot_id.",
  book_appointment:
    "Book an appointment in a time slot the lead chose from get_available_times.",
  mark_dnc:
    "Add the lead to the do-not-call list when they ask not to be contacted again.",
};

type Param = {
  id: string;
  type: "string";
  description: string;
  dynamic_variable: string;
  constant_value: string;
  required: boolean;
  value_type: "llm_prompt" | "dynamic_variable" | "constant_value";
};

/** The call_id parameter every tool carries, bound to the {{call_id}}
 *  dynamic variable our conversation-init webhook supplies. The LLM never
 *  fills this — it's injected at call time so we can resolve the lead. */
const CALL_ID_PARAM: Param = {
  id: "call_id",
  type: "string",
  description:
    "Internal call identifier. Provided automatically — do not ask the caller for it.",
  dynamic_variable: "call_id",
  constant_value: "",
  required: true,
  value_type: "dynamic_variable",
};

/** An LLM-filled string parameter. */
function llmParam(id: string, description: string, required: boolean): Param {
  return {
    id,
    type: "string",
    description,
    dynamic_variable: "",
    constant_value: "",
    required,
    value_type: "llm_prompt",
  };
}

function paramsFor(key: ServerToolKey): Param[] {
  switch (key) {
    case "send_email":
      return [
        CALL_ID_PARAM,
        llmParam(
          "email",
          "The lead's email address in standard format, e.g. 'jane@business.com'. Read it back to confirm before calling.",
          true,
        ),
        llmParam(
          "note",
          "Short note on what information the lead asked to be sent.",
          false,
        ),
      ];
    case "schedule_callback":
      return [
        CALL_ID_PARAM,
        llmParam(
          "callback_datetime",
          "The requested callback time in ISO 8601 with timezone offset, e.g. '2026-01-15T14:00:00-06:00'.",
          true,
        ),
        llmParam("note", "Optional note about the callback.", false),
      ];
    case "get_available_times":
      return [CALL_ID_PARAM];
    case "book_appointment":
      return [
        CALL_ID_PARAM,
        llmParam(
          "slot_id",
          "The slot_id of the chosen time, taken from the get_available_times result.",
          true,
        ),
        llmParam(
          "email",
          "The lead's email for the calendar invite, standard format e.g. 'jane@business.com'.",
          true,
        ),
        llmParam("name", "The lead's name for the calendar invite.", false),
      ];
    case "mark_dnc":
      return [
        CALL_ID_PARAM,
        llmParam(
          "reason",
          "Optional short reason the lead gave for opting out.",
          false,
        ),
      ];
  }
}

/** Build the ElevenLabs tool_config for one key. */
function buildToolConfig(
  key: ServerToolKey,
  baseUrl: string,
  secret: string,
): Record<string, unknown> {
  return {
    type: "webhook",
    name: toolFunctionName(key),
    description: TOOL_DESCRIPTIONS[key],
    response_timeout_secs: 20,
    api_schema: {
      url: `${baseUrl}/api/elevenlabs/tools/${key}`,
      method: "POST",
      path_params_schema: [],
      query_params_schema: [],
      request_body_schema: {
        id: "body",
        type: "object",
        description: `Parameters for the ${key} tool.`,
        required: true,
        properties: paramsFor(key),
      },
      request_headers: [
        { type: "value", name: "Content-Type", value: "application/json" },
        { type: "value", name: "x-tool-secret", value: secret },
      ],
    },
  };
}

/** List every workspace tool, paging through the cursor, returning a
 *  name → id map so we can reuse existing tools instead of duplicating. */
async function listToolsByName(apiKey: string): Promise<Map<string, string>> {
  const byName = new Map<string, string>();
  let cursor: string | null = null;
  // Bounded loop so a misbehaving cursor can't spin forever.
  for (let page = 0; page < 20; page++) {
    const url: string = cursor
      ? `${TOOLS_API}?cursor=${encodeURIComponent(cursor)}`
      : TOOLS_API;
    const res = await fetch(url, { headers: { "xi-api-key": apiKey } });
    if (!res.ok) break;
    const data = (await res.json()) as {
      tools?: { id?: string; tool_config?: { name?: string } }[];
      has_more?: boolean;
      next_cursor?: string | null;
    };
    for (const t of data.tools ?? []) {
      const name = t.tool_config?.name;
      if (name && t.id) byName.set(name, t.id);
    }
    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }
  return byName;
}

// Resolved once per process — the configs are static for the process lifetime
// (their URL depends only on the app base URL). Only successful resolutions
// are cached so a transient failure can be retried on the next sync.
let cachedToolIds: Record<string, string> | null = null;

/**
 * Ensure all five server tools exist in the ElevenLabs workspace and return
 * a key → tool_id map. Mocked (no network) unless ELEVENLABS_LIVE=live.
 * Returns {} when the app URL or secret isn't configured — the caller then
 * attaches no tool_ids, which is recoverable via the re-sync button once the
 * env is set.
 */
export async function ensureServerTools(): Promise<Record<string, string>> {
  if (!isLive()) {
    return Object.fromEntries(
      SERVER_TOOL_KEYS.map((k) => [k, `tool_mock_${k}`]),
    );
  }
  if (cachedToolIds) return cachedToolIds;

  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  const baseUrl = appBaseUrl();
  const secret = await getToolWebhookSecret();
  // Without a public URL + secret we can't register a callable webhook.
  if (!apiKey || !baseUrl || !secret) return {};

  try {
    const existing = await listToolsByName(apiKey);
    const out: Record<string, string> = {};

    for (const key of SERVER_TOOL_KEYS) {
      const config = buildToolConfig(key, baseUrl, secret);
      // Match on the namespaced function name so we only ever reuse/patch OUR
      // tool, never a same-named tool from another product in this shared
      // workspace.
      const existingId = existing.get(toolFunctionName(key));

      if (existingId) {
        // Refresh the definition (URL/secret/schema may have changed) but keep
        // the id even if the update fails — the tool still exists.
        await fetch(`${TOOLS_API}/${encodeURIComponent(existingId)}`, {
          method: "PATCH",
          headers: {
            "xi-api-key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ tool_config: config }),
        });
        out[key] = existingId;
        continue;
      }

      const res = await fetch(TOOLS_API, {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ tool_config: config }),
      });
      if (res.ok) {
        const created = (await res.json()) as { id?: string };
        if (created.id) out[key] = created.id;
      }
    }

    cachedToolIds = out;
    return out;
  } catch {
    return {};
  }
}

/** The tool_ids to attach to an agent, given which tools the wizard enabled.
 *  transfer_to_number is a system tool, not a server tool, so it's excluded
 *  here (its destination is injected per call). */
export function toolIdsForEnabled(
  toolMap: Record<string, string>,
  toolsEnabled: ToolsEnabled | undefined,
): string[] {
  return SERVER_TOOL_KEYS.filter((k) => toolsEnabled?.[k])
    .map((k) => toolMap[k])
    .filter((id): id is string => Boolean(id));
}
