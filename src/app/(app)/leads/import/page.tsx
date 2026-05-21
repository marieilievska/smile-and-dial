import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

import { ImportWizard } from "./import-wizard";

export default async function ImportLeadsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: lists }, { data: customFields }] = await Promise.all([
    supabase.from("lists").select("id, name").order("name"),
    supabase
      .from("custom_field_defs")
      .select("id, name")
      .order("sort_order", { ascending: true }),
  ]);

  return (
    <div className="p-8">
      <h1 className="text-foreground text-2xl font-bold tracking-tight">
        Import leads
      </h1>
      <p className="text-muted-foreground mt-1 text-sm">
        Upload a CSV file to add leads to a list.
      </p>
      <div className="mt-6 max-w-2xl">
        <ImportWizard lists={lists ?? []} customFields={customFields ?? []} />
      </div>
    </div>
  );
}
