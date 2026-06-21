import { Lock } from "lucide-react";
import { redirect } from "next/navigation";

import { ARCHIVED_OWNER_EMAIL } from "@/lib/nav";
import { createClient } from "@/lib/supabase/server";

/**
 * Archived storage.
 *
 * Access-gated to a single account: the matching nav entry is only shown to
 * `ARCHIVED_OWNER_EMAIL`, and this route enforces the same rule server-side so
 * nobody else can reach it by typing the URL. For the one account that *can*
 * open it, the page is intentionally a locked wall — there is no archived
 * storage to browse yet.
 */
export default async function ArchivedPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Anyone other than the designated owner shouldn't even know this exists.
  if (!user || (user.email ?? "").toLowerCase() !== ARCHIVED_OWNER_EMAIL) {
    redirect("/today");
  }

  return (
    <div className="flex min-h-[70vh] items-center justify-center p-6">
      <div className="border-border bg-card flex max-w-md flex-col items-center gap-4 rounded-2xl border p-8 text-center shadow-sm">
        <span className="bg-primary/10 text-primary flex size-12 items-center justify-center rounded-2xl">
          <Lock className="size-6" aria-hidden />
        </span>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-foreground text-lg font-semibold tracking-tight">
            Archived storage
          </h1>
          <p className="text-muted-foreground text-sm">
            Nothing archived yet — this space is reserved for storage
            that&apos;s been moved out of the active workspace.
          </p>
        </div>
      </div>
    </div>
  );
}
