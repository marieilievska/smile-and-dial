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
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-8">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          Import leads
        </h1>
        <p className="text-muted-foreground text-sm">
          Bring leads into Smile &amp; Dial. We&apos;ll verify every phone
          number with Twilio and skip the ones we can&apos;t legally call.
        </p>
      </header>
      <ImportWizard lists={lists ?? []} customFields={customFields ?? []} />
    </div>
  );
}
