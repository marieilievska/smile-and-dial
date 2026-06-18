"use server";

import { revalidatePath } from "next/cache";

import { draftAgent, type AgentDraft } from "@/lib/ai/draft-agent";
import {
  applyConnectedAgentIntegration,
  deleteAgentOnElevenLabs,
  fetchElevenLabsAgent,
  syncAgentToElevenLabs,
} from "@/lib/elevenlabs/agents";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/supabase/database.types";

import {
  normalizeDataCollection,
  normalizeEvaluation,
} from "./data-collection";
import type { ToolsEnabled } from "./prompt";

export type AgentResult = {
  error: string | null;
  agentId?: string;
};

/** Create a new agent. Pushing the agent to ElevenLabs happens in Step 16b. */
export async function createAgent(input: {
  name: string;
  voiceId: string;
  aiModel: string;
  personality: string;
  environment: string;
  tone: string;
  goal: string;
  guardrails: string;
  systemPrompt: string;
  toolsEnabled: ToolsEnabled;
  knowledgeBaseIds: string[];
  extraDataCollection?: unknown;
  extraEvaluation?: unknown;
}): Promise<AgentResult> {
  const name = input.name.trim();
  if (!name) return { error: "Give the agent a name." };

  // Sanitize the user-defined fields once; this is also what we persist so
  // the DB only ever holds clean, base-collision-free entries.
  const extraDataCollection = normalizeDataCollection(
    input.extraDataCollection,
  );
  const extraEvaluation = normalizeEvaluation(input.extraEvaluation);

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
      ai_model: input.aiModel.trim() || null,
      system_prompt: input.systemPrompt,
      prompt_personality: input.personality.trim() || null,
      prompt_environment: input.environment.trim() || null,
      prompt_tone: input.tone.trim() || null,
      prompt_goal: input.goal.trim() || null,
      prompt_guardrails: input.guardrails.trim() || null,
      tools_enabled: input.toolsEnabled,
      knowledge_base_ids: input.knowledgeBaseIds,
      extra_data_collection: extraDataCollection as unknown as Json,
      extra_evaluation: extraEvaluation as unknown as Json,
    })
    .select("id")
    .single();
  if (error || !created) return { error: "Could not save the agent." };

  // Mirror the agent to ElevenLabs. On failure roll back so we don't leave
  // a half-saved agent the admin can't reach from the wizard.
  const sync = await syncAgentToElevenLabs(
    {
      name,
      systemPrompt: input.systemPrompt,
      voiceId: input.voiceId.trim() || null,
      aiModel: input.aiModel.trim() || null,
      goal: input.goal.trim() || null,
      extraDataCollection,
      extraEvaluation,
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

/** Connect an agent that already exists in ElevenLabs by its agent ID.
 *  Unlike createAgent, this NEVER pushes config to ElevenLabs — it only
 *  validates the id, pulls the agent's name/voice/model, and stores a
 *  reference (externally_managed=true) so campaigns can use it. The
 *  ElevenLabs agent is left exactly as the user built it. */
export async function connectAgent(input: {
  elevenlabsAgentId: string;
}): Promise<AgentResult> {
  const id = input.elevenlabsAgentId.trim();
  if (!id) return { error: "Paste the ElevenLabs agent ID." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { data: existing } = await supabase
    .from("agents")
    .select("id")
    .eq("elevenlabs_agent_id", id)
    .maybeSingle();
  if (existing) return { error: "That ElevenLabs agent is already connected." };

  const fetched = await fetchElevenLabsAgent(id);
  if (!fetched.ok) return { error: fetched.error };

  // Connected agents get all five server tools by default so the agent can
  // act on calls; the owner can trim these by editing the agent.
  const toolsEnabled: ToolsEnabled = {
    send_email: true,
    schedule_callback: true,
    get_available_times: true,
    book_appointment: true,
    mark_dnc: true,
  };

  const { data: created, error } = await supabase
    .from("agents")
    .insert({
      owner_id: user.id,
      name: fetched.agent.name,
      elevenlabs_agent_id: id,
      voice_id: fetched.agent.voiceId,
      ai_model: fetched.agent.aiModel,
      externally_managed: true,
      tools_enabled: toolsEnabled,
    })
    .select("id")
    .single();
  if (error || !created) return { error: "Could not connect the agent." };

  // Overlay our integration (webhooks + call_id var + tool_ids) onto the
  // existing ElevenLabs agent, preserving its prompt/voice. Best-effort —
  // the link still stands if this fails, and "Re-sync all" retries it.
  await applyConnectedAgentIntegration(id, toolsEnabled);
  revalidatePath("/settings/agents");
  return { error: null, agentId: created.id };
}

/** Update an existing agent and re-sync it to ElevenLabs. */
export async function updateAgent(
  id: string,
  input: {
    name: string;
    voiceId: string;
    aiModel: string;
    personality: string;
    environment: string;
    tone: string;
    goal: string;
    guardrails: string;
    systemPrompt: string;
    toolsEnabled: ToolsEnabled;
    knowledgeBaseIds: string[];
    extraDataCollection?: unknown;
    extraEvaluation?: unknown;
  },
): Promise<AgentResult> {
  const name = input.name.trim();
  if (!name) return { error: "Give the agent a name." };

  const extraDataCollection = normalizeDataCollection(
    input.extraDataCollection,
  );
  const extraEvaluation = normalizeEvaluation(input.extraEvaluation);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { data: existing } = await supabase
    .from("agents")
    .select("elevenlabs_agent_id, externally_managed")
    .eq("id", id)
    .maybeSingle();
  if (!existing) return { error: "That agent no longer exists." };

  const { error } = await supabase
    .from("agents")
    .update({
      name,
      voice_id: input.voiceId.trim() || null,
      ai_model: input.aiModel.trim() || null,
      system_prompt: input.systemPrompt,
      prompt_personality: input.personality.trim() || null,
      prompt_environment: input.environment.trim() || null,
      prompt_tone: input.tone.trim() || null,
      prompt_goal: input.goal.trim() || null,
      prompt_guardrails: input.guardrails.trim() || null,
      tools_enabled: input.toolsEnabled,
      knowledge_base_ids: input.knowledgeBaseIds,
      extra_data_collection: extraDataCollection as unknown as Json,
      extra_evaluation: extraEvaluation as unknown as Json,
    })
    .eq("id", id);
  if (error) return { error: "Could not update the agent." };

  // Connected agents: never push prompt/voice (the user built those in
  // ElevenLabs), but DO re-apply our integration layer so tool changes here
  // take effect — webhooks + call_id var + enabled server tool_ids, merged
  // in without touching the prompt.
  if (existing.externally_managed) {
    if (existing.elevenlabs_agent_id) {
      await applyConnectedAgentIntegration(
        existing.elevenlabs_agent_id,
        input.toolsEnabled,
        extraDataCollection,
      );
    }
    revalidatePath("/settings/agents");
    return { error: null, agentId: id };
  }

  // Re-sync the agent to ElevenLabs (PATCH if it has an id, otherwise create).
  const sync = await syncAgentToElevenLabs(
    {
      name,
      systemPrompt: input.systemPrompt,
      voiceId: input.voiceId.trim() || null,
      aiModel: input.aiModel.trim() || null,
      goal: input.goal.trim() || null,
      extraDataCollection,
      extraEvaluation,
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

/** Delete an agent locally and on ElevenLabs, unless a campaign uses it. */
export async function deleteAgent(id: string): Promise<AgentResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { data: existing } = await supabase
    .from("agents")
    .select("elevenlabs_agent_id, externally_managed")
    .eq("id", id)
    .maybeSingle();
  if (!existing) return { error: "That agent no longer exists." };

  // Block delete if any campaign references this agent.
  const { count: campaignsUsing } = await supabase
    .from("campaigns")
    .select("id", { count: "exact", head: true })
    .eq("agent_id", id);
  if ((campaignsUsing ?? 0) > 0) {
    return {
      error: "This agent is used by a campaign. Detach it before deleting.",
    };
  }

  // For connected agents we only drop our reference — never delete the
  // user's ElevenLabs agent.
  if (existing.elevenlabs_agent_id && !existing.externally_managed) {
    await deleteAgentOnElevenLabs(existing.elevenlabs_agent_id);
  }

  const { error } = await supabase.from("agents").delete().eq("id", id);
  if (error) return { error: "Could not delete the agent." };

  revalidatePath("/settings/agents");
  return { error: null, agentId: id };
}

export type ResyncResult = {
  error: string | null;
  synced?: number;
  failed?: number;
};

type AgentSyncRow = {
  id: string;
  name: string;
  voice_id: string | null;
  ai_model: string | null;
  system_prompt: string | null;
  prompt_goal: string | null;
  elevenlabs_agent_id: string | null;
  extra_data_collection: unknown;
  extra_evaluation: unknown;
  tools_enabled: unknown;
  externally_managed: boolean | null;
};

/** Push ONE agent's current config to ElevenLabs. Connected (externally-managed)
 *  agents get only our integration overlay — webhooks + call_id var + tool_ids,
 *  never their prompt/voice. App-managed agents get the FULL sync, including
 *  their custom data-collection + evaluation fields. Shared by resyncAllAgents
 *  and the per-agent Sync button so both behave identically. */
async function syncAgentRow(
  supabase: Awaited<ReturnType<typeof createClient>>,
  a: AgentSyncRow,
): Promise<{ error: string | null }> {
  if (a.externally_managed) {
    if (!a.elevenlabs_agent_id) return { error: null };
    return applyConnectedAgentIntegration(
      a.elevenlabs_agent_id,
      (a.tools_enabled ?? undefined) as unknown as ToolsEnabled | undefined,
      normalizeDataCollection(a.extra_data_collection),
    );
  }
  const sync = await syncAgentToElevenLabs(
    {
      name: a.name,
      systemPrompt: a.system_prompt ?? "",
      voiceId: a.voice_id?.trim() || null,
      aiModel: a.ai_model?.trim() || null,
      goal: a.prompt_goal?.trim() || null,
      extraDataCollection: normalizeDataCollection(a.extra_data_collection),
      extraEvaluation: normalizeEvaluation(a.extra_evaluation),
      toolsEnabled: (a.tools_enabled ?? undefined) as unknown as
        | ToolsEnabled
        | undefined,
    },
    a.elevenlabs_agent_id,
  );
  if (sync.error) return { error: sync.error };
  if (
    sync.elevenlabsAgentId &&
    sync.elevenlabsAgentId !== a.elevenlabs_agent_id
  ) {
    await supabase
      .from("agents")
      .update({ elevenlabs_agent_id: sync.elevenlabsAgentId })
      .eq("id", a.id);
  }
  return { error: null };
}

/** Push one agent's config to ElevenLabs on demand (full sync incl. custom data
 *  collection for app-managed agents; overlay for connected ones). Admin-only.
 *  The one-click fix for "my new data-collection fields aren't live yet". */
export async function syncAgent(id: string): Promise<AgentResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (me?.role !== "admin") {
    return { error: "Only an admin can sync agents." };
  }

  const { data: agent } = await supabase
    .from("agents")
    .select(
      "id, name, voice_id, ai_model, system_prompt, prompt_goal, elevenlabs_agent_id, extra_data_collection, extra_evaluation, tools_enabled, externally_managed",
    )
    .eq("id", id)
    .maybeSingle();
  if (!agent) return { error: "That agent no longer exists." };

  const r = await syncAgentRow(supabase, agent);
  if (r.error) return { error: r.error };

  revalidatePath("/settings/agents");
  return { error: null, agentId: id };
}

/** Re-push every agent's current config to ElevenLabs. Use after a sync-layer
 *  change (new defaults, webhooks, dynamic-variable placeholders) so agents
 *  created/edited before the change pick it up without opening each one.
 *  Admin-only; processes sequentially to stay within ElevenLabs rate limits.
 *  Returns counts; individual failures don't abort the run. */
export async function resyncAllAgents(): Promise<ResyncResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (me?.role !== "admin") {
    return { error: "Only an admin can re-sync agents." };
  }

  const { data: agents, error } = await supabase
    .from("agents")
    .select(
      "id, name, voice_id, ai_model, system_prompt, prompt_goal, elevenlabs_agent_id, extra_data_collection, extra_evaluation, tools_enabled, externally_managed",
    )
    .order("created_at", { ascending: true });
  if (error) return { error: "Could not load agents." };
  if (!agents || agents.length === 0) {
    return { error: null, synced: 0, failed: 0 };
  }

  let synced = 0;
  let failed = 0;
  for (const a of agents) {
    const r = await syncAgentRow(supabase, a);
    if (r.error) failed += 1;
    else synced += 1;
  }

  revalidatePath("/settings/agents");
  return { error: null, synced, failed };
}

/** Draft the prompt blocks from a plain-English description so an operator
 *  can describe the agent once and refine the pre-filled steps, instead of
 *  writing every block by hand. Uses OpenAI in live mode, a deterministic
 *  sample draft otherwise. */
export async function draftAgentFromDescription(
  description: string,
): Promise<{ draft?: AgentDraft; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const trimmed = description.trim();
  if (trimmed.length < 10) {
    return {
      error: "Add a sentence or two describing what this agent should do.",
    };
  }

  try {
    const draft = await draftAgent(trimmed);
    return { draft };
  } catch {
    return { error: "Couldn't draft the agent. Please try again." };
  }
}
