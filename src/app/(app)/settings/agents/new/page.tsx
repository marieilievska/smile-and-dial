import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

import { AgentWizard } from "../agent-wizard";

export default async function NewAgentPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // app_settings is admin-only; the security-definer RPC lets every
  // authenticated user read just the voice ids for the wizard's picker.
  const [{ data: voiceIdsString }, { data: kbs }] = await Promise.all([
    supabase.rpc("elevenlabs_voice_ids"),
    supabase.from("knowledge_bases").select("id, name").order("name"),
  ]);

  const voiceIds = (voiceIdsString ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const knowledgeBases = (kbs ?? []).map((k) => ({ id: k.id, name: k.name }));

  return <AgentWizard voiceIds={voiceIds} knowledgeBases={knowledgeBases} />;
}
