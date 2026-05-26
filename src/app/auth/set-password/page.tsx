import { redirect } from "next/navigation";

import { AuthShell } from "@/components/auth/auth-shell";
import { createClient } from "@/lib/supabase/server";

import { SetPasswordForm } from "./set-password-form";

export default async function SetPasswordPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <AuthShell
      panelHeadline="Welcome aboard."
      panelSubcopy="Let's get you set up so you can start watching the AI work."
    >
      <SetPasswordForm />
    </AuthShell>
  );
}
