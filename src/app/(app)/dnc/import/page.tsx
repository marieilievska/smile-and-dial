import { ArrowLeft } from "lucide-react";
import Link from "next/link";
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
    <div className="flex flex-col gap-6 p-8">
      <div className="animate-in fade-in slide-in-from-bottom-1 fill-mode-both flex flex-col gap-1 duration-500">
        <Link
          href="/dnc"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 self-start text-xs"
        >
          <ArrowLeft className="size-3" />
          Back to DNC
        </Link>
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
