import { redirect } from "next/navigation";

import { Breadcrumbs } from "@/components/app-shell/breadcrumbs";
import { createClient } from "@/lib/supabase/server";

import { DncImportWizard } from "./import-wizard";

export default async function ImportDncPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <div className="flex flex-col gap-5 p-6">
      {/* Round 36 (N3) — replaced the bespoke "Back to DNC" link with
       *  the shared Breadcrumbs trail so every nested page reads
       *  the same site-hierarchy cue. */}
      <Breadcrumbs
        items={[{ label: "DNC", href: "/dnc" }, { label: "Import" }]}
      />
      <div className="flex flex-col gap-1">
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          Import to DNC
        </h1>
        <p className="text-muted-foreground text-sm">
          Upload a CSV of phone numbers to add to the do-not-call list.
        </p>
      </div>
      <div className="max-w-3xl">
        <DncImportWizard />
      </div>
    </div>
  );
}
