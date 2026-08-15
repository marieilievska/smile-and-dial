import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

import { TemplateGallery } from "../template-gallery";

export default async function NewAgentPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: rows }, { data: me }] = await Promise.all([
    supabase
      .from("agent_templates")
      .select("id, name, description")
      .order("created_at", { ascending: false }),
    supabase.from("profiles").select("role").eq("id", user.id).single(),
  ]);

  const dbTemplates = (rows ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description ?? "",
  }));

  return (
    <TemplateGallery dbTemplates={dbTemplates} isAdmin={me?.role === "admin"} />
  );
}
