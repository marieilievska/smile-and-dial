import { notFound, redirect } from "next/navigation";

import { AgentBuilder, type BuilderAgent } from "../../agent-builder";
import {
  normalizeDataCollection,
  normalizeEvaluation,
} from "@/lib/agents/data-collection";
import { type ToolsEnabled } from "@/lib/agents/prompt";
import { getTemplate, normalizeKeyDetails } from "@/lib/agents/templates";
import { FIXED_VOICES } from "@/lib/elevenlabs/voices";
import { createClient } from "@/lib/supabase/server";

import { AgentWizard, type AgentInitial } from "../../agent-wizard";

export default async function EditAgentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: agent }, { data: kbs }] = await Promise.all([
    supabase
      .from("agents")
      .select(
        "id, name, voice_id, ai_model, system_prompt, prompt_personality, prompt_environment, prompt_tone, prompt_goal, prompt_guardrails, tools_enabled, knowledge_base_ids, extra_data_collection, extra_evaluation, template_key, instructions, prompt_purpose, key_details, script_prose, externally_managed",
      )
      .eq("id", id)
      .maybeSingle(),
    supabase.from("knowledge_bases").select("id, name").order("name"),
  ]);
  if (!agent) notFound();

  // Template-made agents (not externally-managed) get the new one-screen
  // builder; legacy wizard-built and connected agents keep the old wizard.
  const template = agent.template_key
    ? getTemplate(agent.template_key)
    : undefined;
  if (template && !agent.externally_managed) {
    const builderAgent: BuilderAgent = {
      id: agent.id,
      name: agent.name,
      voiceId: agent.voice_id ?? "",
      templateKey: agent.template_key!,
      instructions: agent.instructions ?? template.instructions,
      tools: (agent.tools_enabled as ToolsEnabled) ?? {},
      knowledgeBaseIds: agent.knowledge_base_ids ?? [],
      script: {
        purpose: agent.prompt_purpose ?? "",
        goal: agent.prompt_goal ?? "",
        keyDetails: normalizeKeyDetails(agent.key_details),
        scriptProse: agent.script_prose ?? "",
        dataCollection: normalizeDataCollection(agent.extra_data_collection),
      },
    };
    return (
      <AgentBuilder
        template={template}
        voices={FIXED_VOICES}
        agent={builderAgent}
      />
    );
  }

  const initial: AgentInitial = {
    id: agent.id,
    name: agent.name,
    voiceId: agent.voice_id ?? "",
    aiModel: agent.ai_model ?? "",
    personality: agent.prompt_personality ?? "",
    environment: agent.prompt_environment ?? "",
    tone: agent.prompt_tone ?? "",
    goal: agent.prompt_goal ?? "",
    guardrails: agent.prompt_guardrails ?? "",
    systemPrompt: agent.system_prompt ?? "",
    toolsEnabled: (agent.tools_enabled as ToolsEnabled) ?? {},
    knowledgeBaseIds: agent.knowledge_base_ids ?? [],
    extraDataCollection: normalizeDataCollection(agent.extra_data_collection),
    extraEvaluation: normalizeEvaluation(agent.extra_evaluation),
  };

  return (
    <AgentWizard
      voices={FIXED_VOICES}
      knowledgeBases={(kbs ?? []).map((k) => ({ id: k.id, name: k.name }))}
      agent={initial}
    />
  );
}
