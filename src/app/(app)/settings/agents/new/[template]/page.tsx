import { notFound, redirect } from "next/navigation";

import { FIXED_VOICES } from "@/lib/elevenlabs/voices";
import { resolveTemplate } from "@/lib/agents/templates/resolve";
import { createClient } from "@/lib/supabase/server";

import { AgentBuilder } from "../../agent-builder";

export default async function NewFromTemplatePage({
  params,
}: {
  params: Promise<{ template: string }>;
}) {
  const { template: key } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Resolve a code-seed key (webinar, blank) OR a saved DB template by id, so
  // both the seeded cards and the "save as template" cards open the builder.
  const template = await resolveTemplate(key, supabase);
  if (!template) notFound();

  return <AgentBuilder template={template} voices={FIXED_VOICES} />;
}
