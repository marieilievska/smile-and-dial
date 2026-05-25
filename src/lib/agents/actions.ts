"use server";

import { revalidatePath } from "next/cache";

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

  revalidatePath("/settings/agents");
  return { error: null, agentId: created.id };
}
