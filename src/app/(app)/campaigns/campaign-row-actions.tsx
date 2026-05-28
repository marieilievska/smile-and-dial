"use client";

import { Copy, Pause, Play, Square } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  cloneCampaign,
  endCampaign,
  pauseCampaign,
  resumeCampaign,
} from "@/lib/campaigns/actions";

/** Hover-only action cluster on a campaign row. Labelled buttons
 *  matching the rest of the app's pattern.
 *
 *  Layout (depends on current status):
 *   - active  → Pause (warning), Clone, End
 *   - paused  → Resume (coral primary), Clone, End
 *   - draft   → Clone, End
 *   - ended   → Clone only
 *
 *  Edit is intentionally absent — the campaign name in the primary
 *  cell IS the trigger that opens the settings sheet. Delete also
 *  lives on the row but as a separate component (DeleteCampaignDialog)
 *  rendered alongside this one. */
export function CampaignRowActions({
  campaign,
}: {
  campaign: { id: string; name: string; status: string };
}) {
  const [pending, startTransition] = useTransition();
  const [endOpen, setEndOpen] = useState(false);
  const isEnded = campaign.status === "ended";
  const isActive = campaign.status === "active";
  const isPaused = campaign.status === "paused";

  function stop(event: React.SyntheticEvent) {
    event.stopPropagation();
  }

  function run(label: string, action: () => Promise<{ error: string | null }>) {
    startTransition(async () => {
      try {
        const result = await action();
        if (result.error) toast.error(result.error);
        else toast.success(`Campaign ${label}.`);
      } catch {
        toast.error("Something went wrong. Please try again.");
      }
    });
  }

  return (
    <div
      data-testid="campaign-row-actions"
      onClick={stop}
      onKeyDown={stop}
      className="ml-auto flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
    >
      {isActive ? (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Pause ${campaign.name}`}
          disabled={pending}
          onClick={() => run("paused", () => pauseCampaign(campaign.id))}
          className="text-warning hover:bg-warning/10 hover:text-warning h-7 px-2"
        >
          <Pause className="size-3.5" />
          Pause
        </Button>
      ) : null}
      {isPaused ? (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Resume ${campaign.name}`}
          disabled={pending}
          onClick={() => run("resumed", () => resumeCampaign(campaign.id))}
          className="text-primary hover:bg-primary/10 hover:text-primary h-7 px-2"
        >
          <Play className="size-3.5" />
          Resume
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Clone ${campaign.name}`}
        disabled={pending}
        onClick={() => run("cloned", () => cloneCampaign(campaign.id))}
        className="h-7 px-2"
      >
        <Copy className="size-3.5" />
        Clone
      </Button>
      {!isEnded ? (
        <AlertDialog open={endOpen} onOpenChange={setEndOpen}>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`End ${campaign.name}`}
              disabled={pending}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive h-7 px-2"
            >
              <Square className="size-3.5" />
              End
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent onClick={stop}>
            <AlertDialogHeader>
              <AlertDialogTitle>
                End &ldquo;{campaign.name}&rdquo;?
              </AlertDialogTitle>
              <AlertDialogDescription>
                Ending stops the campaign permanently and releases its Twilio
                number back to the pool. Attached lists are detached. This
                cannot be undone — clone the campaign first if you might want to
                restart with the same setup.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={pending}
                onClick={() => run("ended", () => endCampaign(campaign.id))}
              >
                End campaign
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  );
}
