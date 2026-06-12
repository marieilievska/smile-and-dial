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

import { createClient as createServiceClient } from "@supabase/supabase-js";

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
      "The single best read on how the call ended. Use EXACTLY one of: " +
      "goal_met (the call ACCOMPLISHED the agent's goal for this campaign — e.g. the appointment/booking was made, OR the research/survey questions were all answered. Pick this whenever the goal was achieved, EVEN IF the agent also offered to follow up or the person agreed to a later 'results' / 'check-in' call: a courtesy follow-up does NOT downgrade a met goal. goal_met takes PRIORITY over callback and call_back_later); " +
      "callback (a specific time OR timeframe to call back was given — e.g. 'call me tomorrow at 3', 'try me next week', 'call after 9 to reach the owner'. This is a POSITIVE signal: they're open to talking, just not right now. Use this EVEN IF the person was a gatekeeper / front desk — a scheduled callback is more actionable than 'gatekeeper', so callback WINS over gatekeeper and call_back_later whenever a real time was agreed. Whenever you use this, also fill callback_datetime. Do NOT use this if the goal was already accomplished on this call — that is goal_met); " +
      "call_back_later (a retry seems worthwhile but the person gave NO specific time or timeframe — a busy brush-off like 'not now', 'I'm with a patient', 'call me some other time'. Do NOT use this if the goal was already accomplished on this call — that is goal_met); " +
      "not_interested (the DECISION MAKER — the owner, or a manager who can make the decision — clearly declined and does not want us to call again. ONLY use this when the person who declined is actually the owner/decision maker); " +
      "gatekeeper (the only HUMAN you spoke with was NOT the decision maker — a receptionist, front desk, or other staff who isn't the owner/manager — AND no specific callback time was agreed. Use this whenever you never got through to the decision maker, INCLUDING when that non-decision-maker declines, brushes you off, or answers the pitch on the business's behalf — you do NOT need to be explicitly refused a transfer. BUT if that gatekeeper gave a specific time to call back, use callback instead. Do NOT use it for a voicemail or a call that hung up in the first few seconds); " +
      "hung_up (a human answered but ended the call within the first few seconds — hung up during or right after the greeting, before any real conversation happened); " +
      "voicemail (you only reached a voicemail, answering machine, or automated greeting — no human ever answered); " +
      "dnc (asked never to be called again). " +
      "Leave blank only if none of these clearly apply.",
    type: "string",
    enum: [
      "goal_met",
      "callback",
      "call_back_later",
      "not_interested",
      "gatekeeper",
      "hung_up",
      "voicemail",
      "dnc",
    ],
  },
  {
    id: "decision_maker_reached",
    description:
      "Whether the agent actually spoke with the business's DECISION MAKER " +
      "(the owner or someone who can make the buying decision) — as opposed to " +
      "a receptionist, front-desk, or other gatekeeper. Answer exactly one of: " +
      "yes, no, unknown.",
    type: "string",
    enum: ["yes", "no", "unknown"],
  },
  {
    id: "business_email",
    description:
      "The lead's business email, ONLY if they actually provide one. Record it " +
      "in standard email format, e.g. 'jane@acmeclinic.com'. If they spell it " +
      "out or say it aloud ('jane at acme clinic dot com', 'j-a-n-e ...'), " +
      "convert it to a proper email address. Leave blank if no email was given.",
    type: "string",
  },
  {
    id: "owner_name",
    description:
      "The business OWNER's name — ONLY when the person is explicitly identified " +
      "as the owner (they say 'I'm the owner', or someone refers to them as the " +
      "owner). Do NOT put a name here just because that person answered the phone " +
      "or gave their name — an unspecified role is NOT the owner. Leave blank if " +
      "no one was clearly identified as the owner.",
    type: "string",
  },
  {
    id: "manager_name",
    description:
      "The manager's name — ONLY when the person is explicitly identified as a " +
      "manager. Leave blank otherwise.",
    type: "string",
  },
  {
    id: "employee_name",
    description:
      "The name of whoever we actually spoke with when their role is NOT clearly " +
      "the owner or a manager — e.g. a receptionist, front-desk, or anyone who " +
      "answers and gives a name ('this is Wilson') without stating they own or " +
      "manage the business. When in doubt about someone's role, put their name " +
      "here, not in owner_name.",
    type: "string",
  },
  {
    id: "callback_datetime",
    description:
      "The date and time to call the person back. Fill this ONLY when the " +
      "disposition is callback — i.e. they gave a specific time OR a timeframe. " +
      "Output a full ISO 8601 datetime WITH a timezone offset, e.g. " +
      "'2026-06-12T15:00:00-04:00'. Resolve relative requests against today, " +
      "{{current_date}}: 'tomorrow at 3' -> tomorrow at 15:00; 'next Tuesday " +
      "morning' -> that Tuesday at 09:00; a loose timeframe ('next week', 'in a " +
      "couple days', 'sometime this afternoon') -> a sensible business-hours " +
      "time inside it (e.g. the next business day in that window at 10:00). Use " +
      "the lead's timezone {{lead_timezone}} for the offset. Leave blank when no " +
      "time or timeframe was given (e.g. call_back_later).",
    type: "string",
  },
  {
    id: "objection_summary",
    description:
      "Brief summary of the lead's reason for declining, if outcome is not_interested.",
    type: "string",
  },
];

/** Our standard data-collection fields in ElevenLabs' canonical OBJECT shape
 *  (keyed by identifier), the form the agent API stores and returns. Used to
 *  guarantee every agent — including externally-built ones — captures the
 *  outcome (disposition) plus the contact fields our post-call webhook reads. */
function standardDataCollectionObject(): Record<
  string,
  { type: string; description: string; enum?: string[] }
> {
  const out: Record<
    string,
    { type: string; description: string; enum?: string[] }
  > = {};
  for (const f of DATA_COLLECTION_FIELDS) {
    out[f.id] = { type: f.type, description: f.description };
    // Categorical fields (disposition, decision_maker_reached) ship an `enum`
    // so ElevenLabs constrains the analysis LLM to valid values instead of
    // free text — more reliable than relying on the description alone.
    if ("enum" in f && Array.isArray(f.enum)) out[f.id].enum = f.enum;
  }
  return out;
}

/**
 * Call-quality evaluation criteria (BUILD_PLAN §8 "score"). ElevenLabs' analysis
 * LLM grades each one success / failure / unknown after the call; our post-call
 * webhook averages the gradable ones into a 0–10 score (unknown = "not
 * applicable", excluded). Each prompt says explicitly when to return unknown so
 * a short / no-conversation call doesn't get unfairly graded a 0 — those are
 * gated out of scoring anyway, but it keeps the rationale honest.
 *
 * IDs are prefixed `quality_` so the webhook can tell our quality dimensions
 * apart from any goal/success criterion an agent was built with.
 */
const QUALITY_CRITERIA_FIELDS = [
  {
    id: "quality_rapport",
    name: "quality_rapport",
    prompt:
      "Judge the agent's rapport. Mark success if the agent was warm, natural, " +
      "and personable and the person seemed at ease. Mark failure if the agent " +
      "was robotic, cold, pushy, or awkward. Mark unknown if the call was too " +
      "short to tell (immediate hang-up, voicemail, or no real exchange).",
  },
  {
    id: "quality_objection_handling",
    name: "quality_objection_handling",
    prompt:
      "Judge how the agent handled questions, hesitation, or objections. Mark " +
      "success if it responded calmly, respectfully, and helpfully. Mark failure " +
      "if it ignored, fumbled, or argued with an objection. Mark unknown if no " +
      "questions or objections came up.",
  },
  {
    id: "quality_goal_progress",
    name: "quality_goal_progress",
    prompt:
      "Judge whether the agent advanced the call's purpose — booking the goal, " +
      "capturing the needed information, or earning a clear next step. Mark " +
      "success if it clearly moved things forward, failure if it had the chance " +
      "and didn't, unknown if there was no real conversation to move forward.",
  },
  {
    id: "quality_clarity",
    name: "quality_clarity",
    prompt:
      "Judge clarity and professionalism. Mark success if the agent was clear, " +
      "concise, on-message, and professional throughout. Mark failure if it was " +
      "confusing, rambling, repetitive, or unprofessional. Mark unknown if the " +
      "call was too short to judge.",
  },
];

/** Our quality criteria in ElevenLabs' canonical evaluation shape (an array of
 *  prompt criteria scoped to the whole conversation). Merged into each agent's
 *  existing criteria so an agent's own goal criterion is preserved. */
function standardEvaluationCriteria(): Array<{
  id: string;
  name: string;
  type: "prompt";
  conversation_goal_prompt: string;
  use_knowledge_base: boolean;
  scope: "conversation";
}> {
  return QUALITY_CRITERIA_FIELDS.map((c) => ({
    id: c.id,
    name: c.name,
    type: "prompt" as const,
    conversation_goal_prompt: c.prompt,
    use_knowledge_base: false,
    scope: "conversation" as const,
  }));
}

/** The set of quality-criterion IDs, exported so the post-call webhook scores
 *  over exactly these (and ignores agent-specific goal criteria). */
export const QUALITY_CRITERIA_IDS = QUALITY_CRITERIA_FIELDS.map((c) => c.id);

/** Merge our quality criteria INTO an agent's existing evaluation criteria:
 *  keep any the agent already had (e.g. a goal/success criterion), replace ours
 *  by id so re-syncs stay idempotent. Returns the full criteria array. */
function mergeEvaluationCriteria(
  existingEvaluation: unknown,
): Array<Record<string, unknown>> {
  const ours = standardEvaluationCriteria();
  const ourIds = new Set(ours.map((c) => c.id));
  const prevCriteria =
    existingEvaluation &&
    typeof existingEvaluation === "object" &&
    Array.isArray((existingEvaluation as { criteria?: unknown }).criteria)
      ? ((existingEvaluation as { criteria: unknown[] }).criteria as Array<
          Record<string, unknown>
        >)
      : [];
  const kept = prevCriteria.filter(
    (c) => c && typeof c === "object" && !ourIds.has(String(c.id)),
  );
  return [...kept, ...ours];
}

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
/** The workspace post-call webhook id to attach to our agents.
 *
 *  DB-FIRST: the id that pairs with the registered SmileDial post-call webhook
 *  lives in app_settings. A stale or empty ELEVENLABS_POST_CALL_WEBHOOK_ID in
 *  Vercel's (unreliable) env store would otherwise win and stamp the WRONG
 *  webhook id onto every agent we sync — so ElevenLabs delivers transcripts/
 *  audio to a dead address and the calls never reach us. The DB value is
 *  therefore authoritative; env is only a fallback when the DB has none. This
 *  mirrors getElevenLabsWebhookSecret's DB-first resolution (the id and its
 *  signing secret must agree). Returns undefined when neither is set. */
async function postCallWebhookId(): Promise<string | undefined> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) {
    try {
      const sb = createServiceClient(url, key, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data } = await sb
        .from("app_settings")
        .select("elevenlabs_post_call_webhook_id")
        .eq("id", 1)
        .maybeSingle();
      const v = (data as { elevenlabs_post_call_webhook_id?: string } | null)
        ?.elevenlabs_post_call_webhook_id;
      if (typeof v === "string" && v.length > 0) return v;
    } catch {
      // fall through to env
    }
  }
  const env = process.env.ELEVENLABS_POST_CALL_WEBHOOK_ID?.trim();
  return env && env.length > 0 ? env : undefined;
}

/** The conversation-initiation override every agent reports to: ElevenLabs
 *  calls this at call start to fetch per-call dynamic variables (call_type,
 *  summaries, lead context, transfer number). Built from NEXT_PUBLIC_APP_URL
 *  + the shared init secret; omitted entirely if either is missing so the
 *  agent body stays valid in environments without them. */
async function conversationInitWebhook(): Promise<
  { url: string; request_headers: Record<string, string> } | undefined
> {
  const base = appBaseUrl();
  if (!base) return undefined;
  // Env wins; otherwise the DB value (Vercel env store has been unreliable
  // for this project, which left this empty and made agents fall back to the
  // workspace default init webhook — pointed at the old V2 project).
  let secret = process.env.ELEVENLABS_INIT_WEBHOOK_SECRET?.trim() ?? "";
  if (!secret) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (url && key) {
      try {
        const sb = createServiceClient(url, key, {
          auth: { autoRefreshToken: false, persistSession: false },
        });
        const { data } = await sb
          .from("app_settings")
          .select("elevenlabs_init_webhook_secret")
          .eq("id", 1)
          .maybeSingle();
        const v = (data as { elevenlabs_init_webhook_secret?: string } | null)
          ?.elevenlabs_init_webhook_secret;
        if (typeof v === "string" && v.length > 0) secret = v;
      } catch {
        // fall through — without a secret we omit the webhook (no insecure
        // unauthenticated init endpoint exposure)
      }
    }
  }
  if (!secret) return undefined;
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

/** Our post-call webhook block (when a webhook id is configured). Requests
 *  the audio event too (send_audio) so completed calls get their recording
 *  stored, not just the transcript. */
async function postCallWebhookBlock(): Promise<
  Record<string, unknown> | undefined
> {
  const webhookId = await postCallWebhookId();
  if (!webhookId) return undefined;
  return {
    post_call_webhook_id: webhookId,
    events: ["transcript", "audio", "call_initiation_failure"],
    transcript_format: "json",
    send_audio: true,
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
  const postCall = await postCallWebhookBlock();
  const initWebhook = await conversationInitWebhook();
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
      // Merge our standard capture fields (disposition + owner/manager/employee
      // names + business_email + callback) INTO the agent's existing data
      // collection — its own custom fields are preserved, ours are added — so
      // even an externally-built agent reports the outcome and contact details
      // our post-call webhook reads.
      data_collection: {
        ...(ps.data_collection &&
        typeof ps.data_collection === "object" &&
        !Array.isArray(ps.data_collection)
          ? (ps.data_collection as Record<string, unknown>)
          : {}),
        ...standardDataCollectionObject(),
      },
      // Merge our quality criteria into the agent's evaluation so every call
      // gets graded (the post-call webhook averages them into a 0–10 score).
      // The agent's own goal criterion, if any, is preserved.
      evaluation: {
        ...(ps.evaluation &&
        typeof ps.evaluation === "object" &&
        !Array.isArray(ps.evaluation)
          ? (ps.evaluation as Record<string, unknown>)
          : {}),
        criteria: mergeEvaluationCriteria(ps.evaluation),
      },
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
  const webhookId = await postCallWebhookId();
  const initWebhook = await conversationInitWebhook();

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
      // Request the audio event so completed calls get their recording stored.
      send_audio: true,
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
        // Three layers, all merged: the agent's own goal criterion, our
        // standard call-quality criteria (so every new agent gets a 0–10
        // score with no extra setup), then any criteria the creator added.
        criteria: [
          {
            id: "goal",
            name: "Goal met",
            type: "prompt",
            conversation_goal_prompt:
              payload.goal || "Did the agent accomplish its stated goal?",
          },
          ...standardEvaluationCriteria(),
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
