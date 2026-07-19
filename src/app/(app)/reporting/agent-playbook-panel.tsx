"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { BookOpenCheck, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { refreshAgentPlaybook } from "@/lib/review/actions";
import type { AgentPlaybookView } from "@/lib/review/playbook-data";

/** Each agent's own required steps, read out of its system prompt. This is what
 *  "Skipped a required step" is measured against, so it has to be inspectable —
 *  a checklist nobody can see is a checklist nobody can trust. */
export function AgentPlaybookPanel({
  playbooks,
}: {
  playbooks: AgentPlaybookView[];
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <BookOpenCheck className="text-muted-foreground size-5" />
        <h2 className="text-foreground text-base font-semibold">
          What each agent has to do
        </h2>
      </div>
      <p className="text-muted-foreground -mt-2 text-xs">
        Pulled from each agent&apos;s own system prompt, and re-read on every
        review — edit the prompt in ElevenLabs and this follows. Steps marked{" "}
        <em>exact</em> have to happen a specific way; the rest just have to
        happen, in whatever words.
      </p>
      {playbooks.length === 0 ? (
        <p className="text-muted-foreground text-sm">No agents yet.</p>
      ) : (
        playbooks.map((p) => <AgentCard key={p.agentId} playbook={p} />)
      )}
    </div>
  );
}

function AgentCard({ playbook }: { playbook: AgentPlaybookView }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function resync(force: boolean) {
    start(async () => {
      const r = await refreshAgentPlaybook({
        agentId: playbook.agentId,
        force,
      });
      if (r.error) {
        toast.error(r.error);
        return;
      }
      toast.success(`Synced — ${r.steps} step${r.steps === 1 ? "" : "s"}.`);
      router.refresh();
    });
  }

  return (
    <div className="border-border flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="text-foreground text-sm font-medium">
            {playbook.agentName}
          </span>
          <span className="text-muted-foreground text-xs">
            {playbook.syncedAt
              ? `${playbook.steps.length} steps · synced ${new Date(playbook.syncedAt).toLocaleString()}`
              : "Not read yet — this happens on the agent's next reviewed call."}
          </span>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => resync(false)}
            title="Re-read the prompt from ElevenLabs and update if it changed"
          >
            <RefreshCw className="mr-1 size-3.5" />
            Sync now
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => resync(true)}
            title="Work the checklist out again from scratch, even if the prompt hasn't changed"
          >
            Rebuild
          </Button>
        </div>
      </div>

      {playbook.steps.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          {playbook.promptChars === 0
            ? "No prompt could be read for this agent — check it's still connected to ElevenLabs."
            : "No steps derived yet."}
        </p>
      ) : (
        <div className="border-border overflow-hidden rounded-lg border">
          {playbook.steps.map((s, i) => (
            <div
              key={s.key}
              className={`flex flex-col gap-1 px-3 py-2 ${
                i > 0 ? "border-border border-t" : ""
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-foreground text-sm">{s.title}</span>
                {s.rigid ? (
                  <Badge
                    variant="outline"
                    className="border-amber-300 text-amber-700"
                  >
                    exact
                  </Badge>
                ) : (
                  <Badge variant="secondary">any wording</Badge>
                )}
              </div>
              <span className="text-muted-foreground text-xs">
                When: {s.applies_when}
              </span>
              <span className="text-muted-foreground text-xs">
                {s.requirement}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
