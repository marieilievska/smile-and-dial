"use server";

import { revalidatePath } from "next/cache";

import {
  deleteAgentOnElevenLabs,
  syncAgentToElevenLabs,
} from "@/lib/elevenlabs/agents";
import { createClient } from "@/lib/supabase/server";

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
}): Promise<AgentResult> {
  const name = input.name.trim();
  if (!name) return { error: "Give the agent a name." };

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
    return { error: "Only admins can build agents." };
  }

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
  },
): Promise<AgentResult> {
  const name = input.name.trim();
  if (!name) return { error: "Give the agent a name." };

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
    return { error: "Only admins can edit agents." };
  }

  const { data: existing } = await supabase
    .from("agents")
    .select("elevenlabs_agent_id")
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
    })
    .eq("id", id);
  if (error) return { error: "Could not update the agent." };

  // Re-sync the agent to ElevenLabs (PATCH if it has an id, otherwise create).
  const sync = await syncAgentToElevenLabs(
    {
      name,
      systemPrompt: input.systemPrompt,
      voiceId: input.voiceId.trim() || null,
      aiModel: input.aiModel.trim() || null,
      goal: input.goal.trim() || null,
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

/**
 * Delete an agent locally and on ElevenLabs. Once campaigns exist
 * (Step 18) this will also block deletion of an agent a campaign uses.
 */
export async function deleteAgent(id: string): Promise<AgentResult> {
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
    return { error: "Only admins can delete agents." };
  }

  const { data: existing } = await supabase
    .from("agents")
    .select("elevenlabs_agent_id")
    .eq("id", id)
    .maybeSingle();
  if (!existing) return { error: "That agent no longer exists." };

  if (existing.elevenlabs_agent_id) {
    await deleteAgentOnElevenLabs(existing.elevenlabs_agent_id);
  }

  const { error } = await supabase.from("agents").delete().eq("id", id);
  if (error) return { error: "Could not delete the agent." };

  revalidatePath("/settings/agents");
  return { error: null, agentId: id };
}
