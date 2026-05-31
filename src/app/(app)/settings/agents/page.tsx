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

import { formatCreatedAt } from "../format-created";
import { DeleteAgentDialog } from "./delete-agent-dialog";

export default async function AgentsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Pull agents + their campaign attachments in parallel so we can
  // surface "Used by N active campaigns" inline. RLS scopes both.
  const [{ data: rawAgents }, { data: campaigns }] = await Promise.all([
    supabase
      .from("agents")
      .select("id, name, voice_id, ai_model, elevenlabs_agent_id, created_at")
      .order("created_at", { ascending: false }),
    supabase
      .from("campaigns")
      .select("id, agent_id, status")
      .neq("status", "ended"),
  ]);
  const agents = rawAgents ?? [];

  const usageByAgent = new Map<string, number>();
  for (const c of campaigns ?? []) {
    if (!c.agent_id) continue;
    usageByAgent.set(c.agent_id, (usageByAgent.get(c.agent_id) ?? 0) + 1);
  }

  const totalAgents = agents.length;
  const now = new Date();

  return (
    <div className="flex flex-col gap-5 p-6">
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

      {totalAgents > 0 ? (
        <>
          {/* Round 29 — dropped the stat strip. The "Used by N
           *  campaigns" inline chip + the Synced badge already carry
           *  the per-row signal; a workspace summary row up top was
           *  chrome tax. */}

          <div className="border-border overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Voice</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>ElevenLabs</TableHead>
                  <TableHead>Used by</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-40" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {agents.map((agent) => {
                  const usage = usageByAgent.get(agent.id) ?? 0;
                  return (
                    <TableRow key={agent.id} className="group">
                      <TableCell className="font-medium">
                        {agent.name}
                      </TableCell>
                      <TableCell
                        className="text-muted-foreground font-mono text-xs"
                        title={agent.voice_id ?? undefined}
                      >
                        {agent.voice_id
                          ? `${agent.voice_id.slice(0, 8)}…`
                          : "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {agent.ai_model || "—"}
                      </TableCell>
                      <TableCell>
                        {agent.elevenlabs_agent_id ? (
                          <Badge variant="success" dot>
                            Synced
                          </Badge>
                        ) : (
                          <Badge variant="ghost">Not synced</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs tabular-nums">
                        {usage > 0
                          ? `${usage} active ${usage === 1 ? "campaign" : "campaigns"}`
                          : "Not in use"}
                      </TableCell>
                      <TableCell
                        className="text-muted-foreground tabular-nums"
                        title={new Date(agent.created_at).toLocaleString()}
                      >
                        {formatCreatedAt(agent.created_at, now)}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
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
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </>
      ) : (
        <div className="border-border flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
          <Bot className="text-muted-foreground size-8" />
          <p className="text-foreground text-sm font-medium">No agents yet</p>
          <p className="text-muted-foreground text-sm">
            Build your first agent to start running campaigns.
          </p>
          <Button asChild className="mt-2">
            <Link href="/settings/agents/new">
              <Plus className="size-4" />
              Build your first agent
            </Link>
          </Button>
        </div>
      )}
    </div>
  );
}
