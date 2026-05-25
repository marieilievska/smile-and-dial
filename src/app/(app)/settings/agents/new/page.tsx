import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

import { AgentWizard } from "./agent-wizard";

export default async function NewAgentPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (me?.role !== "admin") redirect("/leads");

  const [{ data: settings }, { data: kbs }] = await Promise.all([
    supabase
      .from("app_settings")
      .select("elevenlabs_voice_ids")
      .eq("id", 1)
      .maybeSingle(),
    supabase.from("knowledge_bases").select("id, name").order("name"),
  ]);

  const voiceIds = (settings?.elevenlabs_voice_ids ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const knowledgeBases = (kbs ?? []).map((k) => ({ id: k.id, name: k.name }));

  return <AgentWizard voiceIds={voiceIds} knowledgeBases={knowledgeBases} />;
}
