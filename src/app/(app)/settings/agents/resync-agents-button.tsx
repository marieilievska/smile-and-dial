"use client";

import { RefreshCw } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { resyncAllAgents } from "@/lib/agents/actions";

/** Re-push every agent's current config to ElevenLabs. Surfaced on the
 *  Agents list so an admin can roll out sync-layer changes (new defaults,
 *  webhooks, dynamic-variable placeholders) to existing agents in one click,
 *  rather than opening and re-saving each agent. */
export function ResyncAgentsButton() {
  const [pending, startTransition] = useTransition();

  function onResync() {
    startTransition(async () => {
      const result = await resyncAllAgents();
      if (result.error) {
        toast.error(result.error);
        return;
      }
      const { synced = 0, failed = 0 } = result;
      if (failed > 0) {
        toast.warning(
          `Re-synced ${synced} agent${synced === 1 ? "" : "s"}; ${failed} failed.`,
        );
      } else {
        toast.success(
          `Re-synced ${synced} agent${synced === 1 ? "" : "s"} to ElevenLabs.`,
        );
      }
    });
  }

  return (
    <Button
      type="button"
      variant="outline"
      onClick={onResync}
      disabled={pending}
      data-testid="resync-agents"
    >
      <RefreshCw className={pending ? "size-4 animate-spin" : "size-4"} />
      {pending ? "Re-syncing…" : "Re-sync all"}
    </Button>
  );
}
