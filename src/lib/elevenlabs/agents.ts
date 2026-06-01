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

export type AgentSyncPayload = {
  name: string;
  systemPrompt: string;
  voiceId: string | null;
  aiModel: string | null;
  /** Used as the Success Evaluation criterion prompt. */
  goal: string | null;
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
        dynamic_variables: {
          dynamic_variable_placeholders: {
            call_type: "",
            last_callback_notes: "",
            last_call_summary: "",
          },
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
        },
      },
      ...(payload.voiceId
        ? {
            tts: {
              voice_id: payload.voiceId,
              model_id: "eleven_v3_conversational",
              expressive_mode: true,
              stability: 0.5,
              speed: 1,
              similarity_boost: 0.8,
              text_normalisation_type: "elevenlabs",
              optimize_streaming_latency: 3,
            },
          }
        : {}),
    },
    platform_settings: {
      data_collection: DATA_COLLECTION_FIELDS,
      evaluation: {
        criteria: [
          {
            id: "goal",
            name: "Goal met",
            type: "prompt",
            conversation_goal_prompt:
              payload.goal || "Did the agent accomplish its stated goal?",
          },
        ],
      },
      guardrails: GUARDRAILS,
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
