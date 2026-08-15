import { notFound, redirect } from "next/navigation";

import { getTemplate } from "@/lib/agents/templates";
import { resolveTemplate } from "@/lib/agents/templates/resolve";
import { FIXED_VOICES } from "@/lib/elevenlabs/voices";
import { createClient } from "@/lib/supabase/server";

import { AgentBuilder } from "../../../agent-builder";

export default async function EditTemplatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Code seeds (webinar, blank) aren't editable — only DB templates are.
  if (getTemplate(id)) redirect("/settings/agents/new");

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
  if (me?.role !== "admin") redirect("/settings/agents");

  const template = await resolveTemplate(id, supabase);
  if (!template) notFound();

  return (
    <AgentBuilder
      template={template}
      voices={FIXED_VOICES}
      mode="template"
      templateId={id}
    />
  );
}
