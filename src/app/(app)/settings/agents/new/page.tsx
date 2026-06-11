import { redirect } from "next/navigation";

import { FIXED_VOICES } from "@/lib/elevenlabs/voices";
import { createClient } from "@/lib/supabase/server";

import { AgentWizard } from "../agent-wizard";

export default async function NewAgentPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: kbs } = await supabase
    .from("knowledge_bases")
    .select("id, name")
    .order("name");

  const knowledgeBases = (kbs ?? []).map((k) => ({ id: k.id, name: k.name }));

  return <AgentWizard voices={FIXED_VOICES} knowledgeBases={knowledgeBases} />;
}
