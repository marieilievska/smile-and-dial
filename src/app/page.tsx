import { redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import { signOut } from "@/lib/auth/actions";
import { createClient } from "@/lib/supabase/server";

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, email, role")
    .eq("id", user.id)
    .single();

  const displayName = profile?.full_name || profile?.email || user.email;

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="border-border bg-card w-full max-w-md rounded-lg border p-8 text-center shadow-sm">
        <p className="text-muted-foreground font-mono text-xs tracking-widest uppercase">
          Internal platform
        </p>
        <h1 className="text-primary mt-3 text-3xl font-bold tracking-tight">
          Smile <span className="text-coral">&amp;</span> Dial
        </h1>
        <p className="text-foreground mt-4 text-base">
          Signed in as <span className="font-medium">{displayName}</span>
        </p>
        <p className="text-muted-foreground mt-1 text-sm">
          Role: <span className="font-mono">{profile?.role ?? "—"}</span>
        </p>
        <form action={signOut} className="border-border mt-6 border-t pt-6">
          <Button type="submit" variant="outline">
            Sign out
          </Button>
        </form>
      </div>
    </main>
  );
}
