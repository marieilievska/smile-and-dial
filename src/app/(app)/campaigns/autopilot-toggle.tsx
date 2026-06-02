"use client";

import { Bot, Loader2, Power } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { setCampaignAutopilot } from "@/lib/campaigns/actions";

/** One-click Autopilot switch on an active campaign row. Off = the AI
 *  auto-dialer skips this campaign (manual Call Now still works); on = it
 *  resumes auto-dialing. Kept compact so it sits inline with the row actions. */
export function AutopilotToggle({
  campaignId,
  enabled,
}: {
  campaignId: string;
  enabled: boolean;
}) {
  const [pending, startTransition] = useTransition();

  function toggle() {
    startTransition(async () => {
      const result = await setCampaignAutopilot(campaignId, !enabled);
      if (result.error) toast.error(result.error);
      else
        toast.success(
          enabled
            ? "Autopilot off — manual calls only."
            : "Autopilot on — the AI will auto-dial.",
        );
    });
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={toggle}
      disabled={pending}
      aria-pressed={enabled}
      title={
        enabled
          ? "Autopilot is ON — click to stop auto-dialing (manual Call Now still works)."
          : "Autopilot is OFF — click to let the AI auto-dial this campaign."
      }
      className={enabled ? "text-success" : "text-muted-foreground"}
    >
      {pending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : enabled ? (
        <Bot className="size-4" />
      ) : (
        <Power className="size-4" />
      )}
      {enabled ? "Autopilot on" : "Autopilot off"}
    </Button>
  );
}
