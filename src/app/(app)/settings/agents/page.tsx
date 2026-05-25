import { Bot, Pencil, Plus } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createClient } from "@/lib/supabase/server";

import { DeleteAgentDialog } from "./delete-agent-dialog";

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

  const { data: agents } = await supabase
    .from("agents")
    .select("id, name, voice_id, ai_model, elevenlabs_agent_id, created_at")
    .order("created_at", { ascending: false });

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

      {agents && agents.length > 0 ? (
        <div className="border-border mt-6 overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Voice</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>ElevenLabs</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-40" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {agents.map((agent) => (
                <TableRow key={agent.id}>
                  <TableCell className="font-medium">{agent.name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {agent.voice_id || "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {agent.ai_model || "—"}
                  </TableCell>
                  <TableCell>
                    {agent.elevenlabs_agent_id ? (
                      <Badge variant="secondary">Synced</Badge>
                    ) : (
                      <span className="text-muted-foreground text-sm">
                        Not synced
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(agent.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        asChild
                        aria-label={`Edit ${agent.name}`}
                      >
                        <Link href={`/settings/agents/${agent.id}/edit`}>
                          <Pencil className="size-4" />
                          Edit
                        </Link>
                      </Button>
                      <DeleteAgentDialog
                        agent={{ id: agent.id, name: agent.name }}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="border-border mt-6 flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
          <Bot className="text-muted-foreground size-8" />
          <p className="text-foreground text-sm font-medium">No agents yet</p>
          <p className="text-muted-foreground text-sm">
            Build your first agent to start running campaigns.
          </p>
        </div>
      )}
    </div>
  );
}
