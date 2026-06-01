import { notFound, redirect } from "next/navigation";

import {
  normalizeDataCollection,
  normalizeEvaluation,
} from "@/lib/agents/data-collection";
import { type ToolsEnabled } from "@/lib/agents/prompt";
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

  const [{ data: agent }, { data: voiceIdsString }, { data: kbs }] =
    await Promise.all([
      supabase
        .from("agents")
        .select(
          "id, name, voice_id, ai_model, system_prompt, prompt_personality, prompt_environment, prompt_tone, prompt_goal, prompt_guardrails, tools_enabled, knowledge_base_ids, extra_data_collection, extra_evaluation",
        )
        .eq("id", id)
        .maybeSingle(),
      supabase.rpc("elevenlabs_voice_ids"),
      supabase.from("knowledge_bases").select("id, name").order("name"),
    ]);
  if (!agent) notFound();

  const voiceIds = (voiceIdsString ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

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
      voiceIds={voiceIds}
      knowledgeBases={(kbs ?? []).map((k) => ({ id: k.id, name: k.name }))}
      agent={initial}
    />
  );
}
