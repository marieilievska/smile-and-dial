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
    <div className="flex min-h-[70vh] flex-col items-center justify-center px-6 text-center">
      <div className="bg-muted text-muted-foreground flex size-16 items-center justify-center rounded-full">
        <Lock className="size-7" aria-hidden />
      </div>
      <h1 className="text-foreground mt-6 text-2xl font-semibold tracking-tight">
        Archived storage
      </h1>
      <p className="text-muted-foreground mt-2 max-w-md text-sm">
        You don&apos;t have access to archived storage.
      </p>
    </div>
  );
}
