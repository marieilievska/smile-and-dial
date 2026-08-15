import { redirect } from "next/navigation";

import { buildTemplateDraftFromAgent } from "@/lib/agents/template-actions";
import { FIXED_VOICES } from "@/lib/elevenlabs/voices";
import { createClient } from "@/lib/supabase/server";

import { AgentBuilder } from "../../agent-builder";

export default async function NewTemplatePage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const { from } = await searchParams;
  if (!from) redirect("/settings/agents");

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

  const result = await buildTemplateDraftFromAgent(from);
  // Narrow on `draft` (not `error`): `error` is a plain `string`, which TS
  // can't treat as a clean truthy/falsy discriminant across the union.
  if (!result.draft) redirect("/settings/agents");

  return (
    <AgentBuilder
      template={result.draft}
      voices={FIXED_VOICES}
      mode="template"
    />
  );
}
