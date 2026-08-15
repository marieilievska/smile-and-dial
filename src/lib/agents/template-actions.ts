"use server";

import { revalidatePath } from "next/cache";

import { splitAgentIntoTemplate } from "@/lib/ai/split-agent-template";
import { fetchElevenLabsAgentPrompt } from "@/lib/elevenlabs/agents";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/supabase/database.types";

import { normalizeDataCollection } from "./data-collection";
import type { ToolsEnabled } from "./prompt";
import {
  normalizeKeyDetails,
  type AgentScript,
  type AgentTemplate,
} from "./templates/types";

export type TemplateResult = { error: string | null; templateId?: string };

async function requireAdmin(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ userId: string } | { error: string }> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };
  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (me?.role !== "admin")
    return { error: "Only an admin can manage templates." };
  return { userId: user.id };
}

function normalizeScript(raw: AgentScript): AgentScript {
  return {
    purpose: raw.purpose ?? "",
    goal: raw.goal ?? "",
    keyDetails: normalizeKeyDetails(raw.keyDetails),
    scriptProse: raw.scriptProse ?? "",
    dataCollection: normalizeDataCollection(raw.dataCollection),
  };
}

export type TemplateInput = {
  name: string;
  description: string;
  instructions: string;
  defaultVoiceId: string;
  tools: ToolsEnabled;
  script: AgentScript;
};

/** Create a shared template. Admin-only. */
export async function saveTemplate(
  input: TemplateInput,
): Promise<TemplateResult> {
  const supabase = await createClient();
  const auth = await requireAdmin(supabase);
  if ("error" in auth) return { error: auth.error };
  if (!input.name.trim()) return { error: "Give the template a name." };
  if (!input.instructions.trim())
    return { error: "Instructions can't be empty." };

  const { data, error } = await supabase
    .from("agent_templates")
    .insert({
      name: input.name.trim(),
      description: input.description.trim(),
      instructions: input.instructions,
      default_voice_id: input.defaultVoiceId.trim() || null,
      tools: input.tools as unknown as Json,
      script: normalizeScript(input.script) as unknown as Json,
      created_by: auth.userId,
    })
    .select("id")
    .single();
  if (error || !data) return { error: "Could not save the template." };

  revalidatePath("/settings/agents/new");
  return { error: null, templateId: data.id };
}

/** Update an existing shared template. Admin-only. */
export async function updateTemplate(
  id: string,
  input: TemplateInput,
): Promise<TemplateResult> {
  const supabase = await createClient();
  const auth = await requireAdmin(supabase);
  if ("error" in auth) return { error: auth.error };
  if (!input.name.trim()) return { error: "Give the template a name." };

  const { error } = await supabase
    .from("agent_templates")
    .update({
      name: input.name.trim(),
      description: input.description.trim(),
      instructions: input.instructions,
      default_voice_id: input.defaultVoiceId.trim() || null,
      tools: input.tools as unknown as Json,
      script: normalizeScript(input.script) as unknown as Json,
    })
    .eq("id", id);
  if (error) return { error: "Could not update the template." };

  revalidatePath("/settings/agents/new");
  return { error: null, templateId: id };
}

/** Delete a shared template. Admin-only. Agents already built from it are
 *  unaffected (they snapshot instructions/script at creation). */
export async function deleteTemplate(id: string): Promise<TemplateResult> {
  const supabase = await createClient();
  const auth = await requireAdmin(supabase);
  if ("error" in auth) return { error: auth.error };

  const { error } = await supabase
    .from("agent_templates")
    .delete()
    .eq("id", id);
  if (error) return { error: "Could not delete the template." };

  revalidatePath("/settings/agents/new");
  return { error: null, templateId: id };
}

/** Build a template DRAFT (not saved) from an existing agent, by fetching its
 *  prompt (from ElevenLabs for connected agents, else the stored system_prompt)
 *  and running the AI split. Admin-only. Returns an AgentTemplate-shaped draft
 *  the builder pre-fills. */
export async function buildTemplateDraftFromAgent(
  agentId: string,
): Promise<
  | { draft: AgentTemplate; error?: undefined }
  | { error: string; draft?: undefined }
> {
  const supabase = await createClient();
  const auth = await requireAdmin(supabase);
  if ("error" in auth) return { error: auth.error };

  const { data: agent } = await supabase
    .from("agents")
    .select(
      "name, elevenlabs_agent_id, externally_managed, system_prompt, voice_id, tools_enabled",
    )
    .eq("id", agentId)
    .maybeSingle();
  if (!agent) return { error: "That agent no longer exists." };

  let promptText = agent.system_prompt ?? "";
  if (agent.externally_managed && agent.elevenlabs_agent_id) {
    promptText =
      (await fetchElevenLabsAgentPrompt(agent.elevenlabs_agent_id)) ?? "";
  }

  const split = await splitAgentIntoTemplate(promptText, agent.name);
  const draft: AgentTemplate = {
    key: "draft",
    name: split.name,
    description: split.description,
    instructions: split.instructions,
    defaultVoiceId: agent.voice_id ?? "",
    tools: (agent.tools_enabled ?? {}) as ToolsEnabled,
    script: {
      purpose: split.purpose,
      goal: split.goal,
      keyDetails: split.keyDetails,
      scriptProse: split.scriptProse,
      dataCollection: [],
    },
  };
  return { draft };
}
