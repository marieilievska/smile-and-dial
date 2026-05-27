import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

import { DncImportWizard } from "./import-wizard";

export default async function ImportDncPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <div className="p-8">
      <h1 className="text-foreground text-2xl font-bold tracking-tight">
        Import to DNC
      </h1>
      <p className="text-muted-foreground mt-1 text-sm">
        Upload a CSV of phone numbers to add to the do-not-call list.
      </p>
      <div className="mt-6 max-w-2xl">
        <DncImportWizard />
      </div>
    </div>
  );
}
