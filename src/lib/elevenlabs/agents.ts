/**
 * Push agent configurations to ElevenLabs. Real API calls only run when
 * ELEVENLABS_LIVE=live; otherwise a deterministic mock generates a fake
 * agent id, so tests and development stay free.
 *
 * Round L1 — the ElevenLabs API key now comes from `ELEVENLABS_API_KEY`
 * (server env), not from the `app_settings` table. One ElevenLabs
 * account sits behind the whole product, so per-tenant config was
 * the wrong shape. The voice-id allowlist is still per-workspace and
 * still lives in `app_settings`.
 */

import {
  toElevenLabsDataCollection,
  toElevenLabsEvaluation,
  type ExtraDataCollectionField,
  type ExtraEvaluationCriterion,
} from "@/lib/agents/data-collection";
import type { ToolsEnabled } from "@/lib/agents/prompt";
import {
  ensureServerTools,
  isOwnServerTool,
  toolIdsForEnabled,
} from "@/lib/elevenlabs/server-tools";
import { appBaseUrl } from "@/lib/app-url";

export type AgentSyncPayload = {
  name: string;
  systemPrompt: string;
  voiceId: string | null;
  aiModel: string | null;
  /** Used as the Success Evaluation criterion prompt. */
  goal: string | null;
  /** User-defined data-collection fields, merged ON TOP of the system base
   *  set. Pre-normalized by the caller (see lib/agents/data-collection). */
  extraDataCollection?: ExtraDataCollectionField[];
  /** User-defined evaluation criteria, merged on top of the base "goal"
   *  criterion. */
  extraEvaluation?: ExtraEvaluationCriterion[];
  /** Which tools the wizard enabled. The custom server tools among these
   *  (send_email, schedule_callback, get_available_times, book_appointment,
   *  mark_dnc) are registered with ElevenLabs and attached as tool_ids. */
  toolsEnabled?: ToolsEnabled;
};

export type SyncResult = {
  elevenlabsAgentId: string | null;
  error: string | null;
};

const ELEVENLABS_API = "https://api.elevenlabs.io/v1/convai/agents";

// Fields ElevenLabs Data Collection extracts after each call.
// See BUILD_PLAN.md Section 9 "Data Collection configuration".
const DATA_COLLECTION_FIELDS = [
  {
    id: "disposition",
    description:
      "The agent's read on call outcome. One of: gatekeeper, not_interested, callback, dnc, goal_met.",
    type: "string",
  },
  {
    id: "business_email",
    description: "The lead's business email, if mentioned.",
    type: "string",
  },
  {
    id: "owner_name",
    description: "The owner's name, if mentioned.",
    type: "string",
  },
  {
    id: "manager_name",
    description: "The manager's name, if mentioned.",
    type: "string",
  },
  {
    id: "employee_name",
    description: "Any other employee name mentioned.",
    type: "string",
  },
  {
    id: "callback_datetime",
    description:
      "ISO 8601 datetime, when the lead asks to be called back at a specific time.",
    type: "string",
  },
  {
    id: "objection_summary",
    description:
      "Brief summary of the lead's reason for declining, if outcome is not_interested.",
    type: "string",
  },
];

/** Built-in system tools every agent gets. These need no per-agent config,
 *  so they're safe as a global default:
 *   - end_call: agent hangs up gracefully when the conversation is done
 *   - voicemail_detection: detect an answering machine and stop
 *   - skip_turn: wait for the caller instead of talking over a pause
 *   - language_detection: switch language if the caller does
 *   - play_keypad_touch_tone: press digits to get through an IVR
 *  transfer_to_number is intentionally NOT here — its destination is
 *  per-campaign, injected at call time by the call-initiation webhook. */
const BUILT_IN_TOOLS = {
  end_call: { params: { system_tool_type: "end_call" } },
  voicemail_detection: {
    params: { system_tool_type: "voicemail_detection", voicemail_message: "" },
  },
  skip_turn: { params: { system_tool_type: "skip_turn" } },
  language_detection: { params: { system_tool_type: "language_detection" } },
  play_keypad_touch_tone: {
    params: {
      system_tool_type: "play_keypad_touch_tone",
      use_out_of_band_dtmf: false,
      suppress_turn_after_dtmf: true,
    },
  },
} as const;

/** Safety guardrails applied to every agent: keep it on-topic (focus),
 *  block prompt-injection, and block unsafe content categories in blocking
 *  mode (validate the full response before any audio plays), retrying with
 *  a redirect when a category trips. Mirrors the reference agent. */
const GUARDRAILS = {
  version: "1",
  focus: { is_enabled: true },
  prompt_injection: { is_enabled: true },
  content: {
    execution_mode: "blocking",
    config: {
      sexual: { is_enabled: true, threshold: "high" },
      violence: { is_enabled: true, threshold: "high" },
      harassment: { is_enabled: true, threshold: "high" },
      self_harm: { is_enabled: true, threshold: "high" },
      profanity: { is_enabled: true, threshold: "high" },
      religion_or_politics: { is_enabled: true, threshold: "high" },
      medical_and_legal_information: { is_enabled: true, threshold: "high" },
    },
    trigger_action: {
      type: "retry",
      feedback:
        "Your response was blocked by a guardrail that blocks content that matches this condition/category: '{{trigger_reason}}' During your next turn you must redirect the conversation.",
    },
  },
} as const;

function isLive(): boolean {
  return process.env.ELEVENLABS_LIVE === "live";
}

/** Workspace-level ElevenLabs resources applied to every agent.
 *
 *  The product runs on ONE ElevenLabs account, so the dictionary and the
 *  analysis model are baked in as defaults — they work out of the box with
 *  no env setup. An env var still overrides each (handy for a staging
 *  account or to swap the analysis model) but isn't required.
 *
 *  The post-call webhook is the exception: it has no sensible default
 *  because the webhook must be CREATED once in the ElevenLabs dashboard and
 *  its generated id pasted into ELEVENLABS_POST_CALL_WEBHOOK_ID. Omitted
 *  from the agent body until that id is set.
 *
 *  - Pronunciation dictionary: the workspace dictionary so brand/industry
 *    terms are said correctly.
 *  - Analysis LLM: the model that runs post-call analysis (data collection
 *    + evaluation). */
const DEFAULT_PRONUNCIATION_DICTIONARY_ID = "C6YPGRdam0tTOORTL9L1";
const DEFAULT_ANALYSIS_LLM = "claude-sonnet-4-6";

function pronunciationDictionaryId(): string | undefined {
  const v = process.env.ELEVENLABS_PRONUNCIATION_DICTIONARY_ID?.trim();
  return v && v.length > 0 ? v : DEFAULT_PRONUNCIATION_DICTIONARY_ID;
}
function analysisLlm(): string | undefined {
  const v = process.env.ELEVENLABS_ANALYSIS_LLM?.trim();
  return v && v.length > 0 ? v : DEFAULT_ANALYSIS_LLM;
}
function postCallWebhookId(): string | undefined {
  const v = process.env.ELEVENLABS_POST_CALL_WEBHOOK_ID?.trim();
  return v && v.length > 0 ? v : undefined;
}

/** The conversation-initiation override every agent reports to: ElevenLabs
 *  calls this at call start to fetch per-call dynamic variables (call_type,
 *  summaries, lead context, transfer number). Built from NEXT_PUBLIC_APP_URL
 *  + the shared init secret; omitted entirely if either is missing so the
 *  agent body stays valid in environments without them. */
function conversationInitWebhook():
  | { url: string; request_headers: Record<string, string> }
  | undefined {
  const base = appBaseUrl();
  const secret = process.env.ELEVENLABS_INIT_WEBHOOK_SECRET?.trim();
  if (!base || !secret) return undefined;
  return {
    url: `${base}/api/elevenlabs/conversation-init`,
    request_headers: { "x-init-secret": secret },
  };
}

/** The single ElevenLabs API key for the whole product. Returns null
 *  if the env var is missing or empty so the caller can surface a
 *  clean error instead of attempting a request with an undefined
 *  Authorization header. */
function fetchApiKey(): string | null {
  const key = process.env.ELEVENLABS_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

/** Delete an ElevenLabs agent. Mocked unless ELEVENLABS_LIVE=live. */
export async function deleteAgentOnElevenLabs(
  agentId: string,
): Promise<{ error: string | null }> {
  if (!isLive()) return { error: null };

  const apiKey = fetchApiKey();
  if (!apiKey) return { error: "ElevenLabs API key isn't set." };

  try {
    const res = await fetch(
      `${ELEVENLABS_API}/${encodeURIComponent(agentId)}`,
      {
        method: "DELETE",
        headers: { "xi-api-key": apiKey },
      },
    );
    if (!res.ok && res.status !== 404) {
      return { error: `ElevenLabs delete failed (${res.status}).` };
    }
    return { error: null };
  } catch {
    return { error: "ElevenLabs delete failed." };
  }
}

export type FetchedAgent = {
  name: string;
  voiceId: string | null;
  aiModel: string | null;
};

/** The dynamic-variable placeholders our webhooks fill per call. Declared on
 *  every agent so its prompt can reference {{var}} and so the tools receive
 *  {{call_id}}. MUST stay in lockstep with the conversation-init webhook. */
const DYNAMIC_VAR_PLACEHOLDERS = {
  call_type: "",
  last_callback_notes: "",
  last_call_summary: "",
  transfer_number: "",
  owner_name: "",
  city: "",
  category: "",
  google_rating: "",
  google_reviews: "",
  call_id: "",
} as const;

/** Our post-call webhook block (when the webhook id env is set). */
function postCallWebhookBlock(): Record<string, unknown> | undefined {
  const webhookId = postCallWebhookId();
  if (!webhookId) return undefined;
  return {
    post_call_webhook_id: webhookId,
    events: ["transcript", "audio", "call_initiation_failure"],
    transcript_format: "json",
    send_audio: false,
  };
}

/**
 * Overlay OUR platform integration onto an agent that was built in ElevenLabs
 * and connected by ID — without disturbing the prompt/voice/model/guardrails
 * the user set up there. We read the agent's current config, then PATCH it
 * back with our webhooks, the call_id dynamic variable, and the enabled
 * server tools merged in. Read-modify-write so nothing is lost; a rejected
 * PATCH is a benign no-op (never data loss). Mocked off-live.
 */
export async function applyConnectedAgentIntegration(
  agentId: string,
  toolsEnabled: ToolsEnabled | undefined,
): Promise<{ error: string | null }> {
  if (!isLive()) return { error: null };
  const apiKey = fetchApiKey();
  if (!apiKey) return { error: "ElevenLabs API key isn't set." };

  let current: {
    conversation_config?: Record<string, unknown>;
    platform_settings?: Record<string, unknown>;
  };
  try {
    const res = await fetch(
      `${ELEVENLABS_API}/${encodeURIComponent(agentId)}`,
      {
        headers: { "xi-api-key": apiKey },
      },
    );
    if (!res.ok) return { error: `ElevenLabs lookup failed (${res.status}).` };
    current = (await res.json()) as typeof current;
  } catch {
    return { error: "ElevenLabs lookup failed." };
  }

  const cc = (current.conversation_config ?? {}) as Record<string, unknown>;
  const agent = (cc.agent ?? {}) as Record<string, unknown>;
  const prompt = (agent.prompt ?? {}) as Record<string, unknown>;

  // Attach our server tools by STABLE workspace tool_ids (ensureServerTools
  // reuses one record per name, so re-syncs never create duplicates).
  const serverToolMap = await ensureServerTools();
  const serverToolIds = toolIdsForEnabled(serverToolMap, toolsEnabled);
  const existingToolIds = Array.isArray(prompt.tool_ids)
    ? (prompt.tool_ids as string[])
    : [];
  const ourToolIds = new Set(Object.values(serverToolMap));
  // Keep the user's own workspace tools; drop our ids so the enabled set
  // below fully controls which of ours are attached.
  const keptToolIds = existingToolIds.filter((id) => !ourToolIds.has(id));
  const mergedToolIds = Array.from(new Set([...keptToolIds, ...serverToolIds]));

  // Agents built in the ElevenLabs dashboard carry a legacy inline `tools`
  // array. The API rejects a body that sets both `tools` and `tool_ids`, so
  // we drop the inline array — but first salvage any system tool it holds
  // (e.g. transfer_to_number with its configured number) into built_in_tools,
  // the modern home for system tools, unless it's already there. This never
  // loses the transfer config and lets us use stable tool_ids cleanly.
  const existingTools = Array.isArray(prompt.tools)
    ? (prompt.tools as Record<string, unknown>[])
    : [];
  const usesInlineTools = existingTools.length > 0;

  const promptPatch: Record<string, unknown> = {
    ...prompt,
    tool_ids: mergedToolIds,
  };
  if (usesInlineTools) {
    const existingBuiltIn = (prompt.built_in_tools ?? {}) as Record<
      string,
      unknown
    >;
    const salvaged: Record<string, unknown> = {};
    for (const t of existingTools) {
      const name = t?.name;
      if (
        t?.type === "system" &&
        typeof name === "string" &&
        !isOwnServerTool(name) &&
        !(name in existingBuiltIn)
      ) {
        salvaged[name] = t;
      }
    }
    promptPatch.built_in_tools = { ...salvaged, ...existingBuiltIn };
    delete promptPatch.tools;
  }

  const dv = (agent.dynamic_variables ?? {}) as Record<string, unknown>;
  const dvp = (dv.dynamic_variable_placeholders ?? {}) as Record<
    string,
    unknown
  >;

  const ps = (current.platform_settings ?? {}) as Record<string, unknown>;
  const existingWo = (ps.workspace_overrides ?? {}) as Record<string, unknown>;
  const existingOverrides = (ps.overrides ?? {}) as Record<string, unknown>;
  const postCall = postCallWebhookBlock();
  const initWebhook = conversationInitWebhook();
  const workspaceOverrides: Record<string, unknown> = {
    ...existingWo,
    ...(postCall ? { webhooks: postCall } : {}),
    ...(initWebhook
      ? { conversation_initiation_client_data_webhook: initWebhook }
      : {}),
  };

  const body = {
    conversation_config: {
      ...cc,
      agent: {
        ...agent,
        dynamic_variables: {
          ...dv,
          dynamic_variable_placeholders: {
            ...dvp,
            ...DYNAMIC_VAR_PLACEHOLDERS,
          },
        },
        prompt: promptPatch,
      },
    },
    platform_settings: {
      ...ps,
      ...(Object.keys(workspaceOverrides).length > 0
        ? { workspace_overrides: workspaceOverrides }
        : {}),
      ...(initWebhook
        ? {
            overrides: {
              ...existingOverrides,
              enable_conversation_initiation_client_data_from_webhook: true,
            },
          }
        : {}),
    },
  };

  try {
    const res = await fetch(
      `${ELEVENLABS_API}/${encodeURIComponent(agentId)}`,
      {
        method: "PATCH",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      return { error: `ElevenLabs integration sync failed (${res.status}).` };
    }
    return { error: null };
  } catch {
    return { error: "ElevenLabs integration sync failed." };
  }
}

/**
 * Look up an existing ElevenLabs agent by id — used by the "connect an
 * existing agent" flow to validate the id and pull its name/voice/model.
 * Read-only; never modifies the agent. Mocked (no network) unless
 * ELEVENLABS_LIVE=live so the flow works in dev/CI.
 */
export async function fetchElevenLabsAgent(
  agentId: string,
): Promise<{ ok: true; agent: FetchedAgent } | { ok: false; error: string }> {
  if (!isLive()) {
    return {
      ok: true,
      agent: {
        name: `Connected agent ${agentId.slice(0, 8)}`,
        voiceId: null,
        aiModel: null,
      },
    };
  }
  const apiKey = fetchApiKey();
  if (!apiKey) return { ok: false, error: "ElevenLabs API key isn't set." };
  try {
    const res = await fetch(
      `${ELEVENLABS_API}/${encodeURIComponent(agentId)}`,
      {
        headers: { "xi-api-key": apiKey },
      },
    );
    if (res.status === 404) {
      return { ok: false, error: "No ElevenLabs agent has that ID." };
    }
    if (!res.ok) {
      return { ok: false, error: `ElevenLabs lookup failed (${res.status}).` };
    }
    const data = (await res.json()) as {
      name?: string;
      conversation_config?: {
        agent?: { prompt?: { llm?: string } };
        tts?: { voice_id?: string };
      };
    };
    return {
      ok: true,
      agent: {
        name: data.name?.trim() || `Connected agent ${agentId.slice(0, 8)}`,
        voiceId: data.conversation_config?.tts?.voice_id ?? null,
        aiModel: data.conversation_config?.agent?.prompt?.llm ?? null,
      },
    };
  } catch {
    return { ok: false, error: "ElevenLabs lookup failed." };
  }
}

/**
 * Create or update an ElevenLabs agent from our wizard inputs. When
 * `existingId` is null, a new agent is created; otherwise the existing
 * agent is updated and the same id is returned.
 */
export async function syncAgentToElevenLabs(
  payload: AgentSyncPayload,
  existingId: string | null,
): Promise<SyncResult> {
  if (!isLive()) return mockSync(existingId);
  return liveSync(payload, existingId);
}

/** Deterministic stand-in: a stable fake id keyed to a UUID. */
function mockSync(existingId: string | null): SyncResult {
  if (existingId) return { elevenlabsAgentId: existingId, error: null };
  return {
    elevenlabsAgentId: `agent_mock_${crypto.randomUUID()}`,
    error: null,
  };
}

async function liveSync(
  payload: AgentSyncPayload,
  existingId: string | null,
): Promise<SyncResult> {
  const apiKey = fetchApiKey();
  if (!apiKey) {
    return {
      elevenlabsAgentId: null,
      error:
        "ElevenLabs API key isn't set. Add ELEVENLABS_API_KEY to the server env.",
    };
  }

  // Build the request body in the ElevenLabs Convai agent shape.
  //
  // Beyond the per-agent fields (name / prompt / llm / voice), every agent
  // gets a fixed set of production-grade defaults — TTS tuning, ASR quality,
  // turn-taking + soft-timeout filler, a backup-LLM cascade, content
  // guardrails, the safe built-in system tools, and dynamic-variable
  // placeholders the call-initiation webhook fills in. These mirror the
  // hand-tuned "Market Research" reference agent so every synced agent
  // behaves like a real call-center rep, not a bare default.
  //
  // NOT defaulted here (deliberate):
  //  - data_collection / evaluation — purpose-specific; the disposition set
  //    below is what our post-call webhook parses for sales agents.
  //  - transfer_to_number — the destination is per-campaign, injected at
  //    call time (see the call-initiation webhook), so it isn't baked in.
  // Optional workspace resources, omitted entirely when their env vars
  // aren't set so the agent body stays valid in every environment.
  const dictId = pronunciationDictionaryId();
  const dictLocators = dictId
    ? [{ pronunciation_dictionary_id: dictId, version_id: null }]
    : undefined;
  const ttsBase: Record<string, unknown> = {
    model_id: "eleven_v3_conversational",
    expressive_mode: true,
    stability: 0.5,
    speed: 1,
    similarity_boost: 0.8,
    text_normalisation_type: "elevenlabs",
    optimize_streaming_latency: 3,
    ...(payload.voiceId ? { voice_id: payload.voiceId } : {}),
    ...(dictLocators
      ? { pronunciation_dictionary_locators: dictLocators }
      : {}),
  };
  // Include the tts block whenever we have a voice OR a pronunciation dict
  // to apply (a dict is useful even on the account default voice).
  const includeTts = Boolean(payload.voiceId) || Boolean(dictLocators);

  const analysis = analysisLlm();
  const webhookId = postCallWebhookId();
  const initWebhook = conversationInitWebhook();

  // Register (idempotently) our five custom server tools and resolve the
  // ElevenLabs tool ids for the ones this agent enabled. Always set tool_ids
  // explicitly — an empty array clears tools the agent no longer uses on an
  // update. Returns [] when the app URL/secret isn't configured yet (the
  // re-sync button rolls them out once it is).
  const serverToolMap = await ensureServerTools();
  const serverToolIds = toolIdsForEnabled(serverToolMap, payload.toolsEnabled);

  // workspace_overrides carries the two workspace-level webhooks every agent
  // shares: the post-call webhook (transcript/audio/failure events) and the
  // conversation-initiation webhook (per-call dynamic variables). Each is
  // included only when its config is present, and the whole block is omitted
  // if neither is — keeping the body valid in bare environments.
  const workspaceOverrides: Record<string, unknown> = {};
  if (webhookId) {
    workspaceOverrides.webhooks = {
      post_call_webhook_id: webhookId,
      events: ["transcript", "audio", "call_initiation_failure"],
      // MUST stay "json" — our post-call handler parses the JSON transcript
      // envelope (data.analysis.disposition). "opentelemetry" would deliver
      // OTLP trace data instead and break outcome parsing.
      transcript_format: "json",
      send_audio: false,
    };
  }
  if (initWebhook) {
    workspaceOverrides.conversation_initiation_client_data_webhook =
      initWebhook;
  }

  const body: Record<string, unknown> = {
    name: payload.name,
    conversation_config: {
      asr: {
        quality: "high",
        provider: "scribe_v2_turbo",
      },
      turn: {
        turn_timeout: 7,
        silence_end_call_timeout: 70,
        turn_eagerness: "normal",
        soft_timeout_config: {
          timeout_seconds: 3,
          message: "Hhmmmm...yeah.",
          use_llm_generated_message: true,
        },
      },
      conversation: {
        max_duration_seconds: 700,
      },
      vad: {
        background_voice_detection: true,
      },
      agent: {
        language: "en",
        // Declared placeholders for every dynamic variable our
        // conversation-init webhook returns (lib/elevenlabs/conversation-init).
        // An agent can only reference {{var}} in its prompt if the variable
        // is declared here, so this MUST stay in lockstep with that webhook's
        // response keys. Values come per-call from the lead/campaign; the ""
        // here are just the declared defaults when a field is empty.
        dynamic_variables: {
          dynamic_variable_placeholders: DYNAMIC_VAR_PLACEHOLDERS,
        },
        prompt: {
          prompt: payload.systemPrompt,
          ...(payload.aiModel ? { llm: payload.aiModel } : {}),
          temperature: 0.5,
          timezone: "America/New_York",
          backup_llm_config: {
            preference: "override",
            order: ["gemini-2.5-flash", "claude-haiku-4-5"],
          },
          cascade_timeout_seconds: 6,
          built_in_tools: BUILT_IN_TOOLS,
          // Workspace tool ids for the enabled custom server tools. Set
          // unconditionally so disabling a tool removes it on the next sync.
          tool_ids: serverToolIds,
        },
      },
      ...(includeTts ? { tts: ttsBase } : {}),
    },
    platform_settings: {
      // System base set + user-defined fields merged on top. normalize
      // already dropped any user id that collides with a base id, so the
      // base fields the post-call webhook depends on always win.
      data_collection: [
        ...DATA_COLLECTION_FIELDS,
        ...(payload.extraDataCollection ?? []).map(toElevenLabsDataCollection),
      ],
      evaluation: {
        criteria: [
          {
            id: "goal",
            name: "Goal met",
            type: "prompt",
            conversation_goal_prompt:
              payload.goal || "Did the agent accomplish its stated goal?",
          },
          ...(payload.extraEvaluation ?? []).map(toElevenLabsEvaluation),
        ],
      },
      guardrails: GUARDRAILS,
      // The model that runs post-call analysis (data collection + eval).
      ...(analysis ? { analysis_llm: analysis } : {}),
      // Workspace webhooks (post-call + conversation-init), built above.
      ...(Object.keys(workspaceOverrides).length > 0
        ? { workspace_overrides: workspaceOverrides }
        : {}),
      // The conversation-init webhook only fires when the agent opts in via
      // this flag, so enable it whenever we're wiring that webhook.
      ...(initWebhook
        ? {
            overrides: {
              enable_conversation_initiation_client_data_from_webhook: true,
            },
          }
        : {}),
    },
  };

  const url = existingId
    ? `${ELEVENLABS_API}/${encodeURIComponent(existingId)}`
    : `${ELEVENLABS_API}/create`;
  const method = existingId ? "PATCH" : "POST";

  try {
    const res = await fetch(url, {
      method,
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return {
        elevenlabsAgentId: null,
        error: `ElevenLabs sync failed (${res.status}).`,
      };
    }
    const data = (await res.json()) as { agent_id?: string };
    return {
      elevenlabsAgentId: data.agent_id ?? existingId,
      error: null,
    };
  } catch {
    return {
      elevenlabsAgentId: null,
      error: "ElevenLabs sync failed.",
    };
  }
}
