"use client";

import { RefreshCw } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { syncAgent } from "@/lib/agents/actions";

/** Per-agent "Sync to ElevenLabs" — pushes THIS agent's full config (including
 *  its custom data-collection fields) to ElevenLabs in one click, without
 *  opening and re-saving the agent in the wizard. */
export function SyncAgentButton({ id, name }: { id: string; name: string }) {
  const [pending, startTransition] = useTransition();

  function onClick() {
    startTransition(async () => {
      try {
        const result = await syncAgent(id);
        if (result.error) {
          toast.error(result.error);
        } else {
          toast.success("Synced to ElevenLabs.");
        }
      } catch {
        toast.error("Sync failed. Try again in a moment.");
      }
    });
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onClick}
      disabled={pending}
      aria-label={`Sync ${name} to ElevenLabs`}
    >
      <RefreshCw className={pending ? "size-4 animate-spin" : "size-4"} />
      {pending ? "Syncing…" : "Sync"}
    </Button>
  );
}
