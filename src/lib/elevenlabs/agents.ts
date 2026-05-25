/**
 * Push agent configurations to ElevenLabs. Real API calls only run when
 * ELEVENLABS_LIVE=live; otherwise a deterministic mock generates a fake
 * agent id, so tests and development stay free.
 */

import { createClient } from "@/lib/supabase/server";

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

function isLive(): boolean {
  return process.env.ELEVENLABS_LIVE === "live";
}

async function fetchApiKey(): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("app_settings")
    .select("elevenlabs_api_key")
    .eq("id", 1)
    .maybeSingle();
  return data?.elevenlabs_api_key ?? null;
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
  const apiKey = await fetchApiKey();
  if (!apiKey) {
    return {
      elevenlabsAgentId: null,
      error: "ElevenLabs API key isn't set in Settings → Integrations.",
    };
  }

  // Build the request body in the ElevenLabs Convai agent shape.
  const body: Record<string, unknown> = {
    name: payload.name,
    conversation_config: {
      agent: {
        prompt: {
          prompt: payload.systemPrompt,
          ...(payload.aiModel ? { llm: payload.aiModel } : {}),
        },
      },
      ...(payload.voiceId ? { tts: { voice_id: payload.voiceId } } : {}),
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
