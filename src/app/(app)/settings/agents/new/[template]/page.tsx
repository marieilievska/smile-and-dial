import { notFound, redirect } from "next/navigation";

import { FIXED_VOICES } from "@/lib/elevenlabs/voices";
import { getTemplate } from "@/lib/agents/templates";
import { createClient } from "@/lib/supabase/server";

import { AgentBuilder } from "../../agent-builder";

export default async function NewFromTemplatePage({
  params,
}: {
  params: Promise<{ template: string }>;
}) {
  const { template: key } = await params;
  const template = getTemplate(key);
  if (!template) notFound();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return <AgentBuilder template={template} voices={FIXED_VOICES} />;
}
