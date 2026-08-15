import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

import { TemplateGallery } from "../template-gallery";

export default async function NewAgentPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return <TemplateGallery />;
}
