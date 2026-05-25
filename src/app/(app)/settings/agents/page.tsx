import { Bot, Plus } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";

export default async function AgentsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (me?.role !== "admin") redirect("/leads");

  const { count } = await supabase
    .from("agents")
    .select("id", { count: "exact", head: true });
  const total = count ?? 0;

  return (
    <div className="p-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-foreground text-2xl font-bold tracking-tight">
            Agents
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            AI agents your campaigns hand a call to.
          </p>
        </div>
        <Button asChild>
          <Link href="/settings/agents/new">
            <Plus className="size-4" />
            Build new agent
          </Link>
        </Button>
      </div>

      <div className="border-border mt-6 flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
        <Bot className="text-muted-foreground size-8" />
        <p className="text-foreground text-sm font-medium">
          {total === 0
            ? "No agents yet"
            : `${total} ${total === 1 ? "agent" : "agents"} built`}
        </p>
        <p className="text-muted-foreground text-sm">
          {total === 0
            ? "Build your first agent to start running campaigns."
            : "A full list with edit and delete is on the way."}
        </p>
      </div>
    </div>
  );
}
