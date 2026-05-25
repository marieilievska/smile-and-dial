"use client";

import { useState, useTransition } from "react";
import { Copy, Pause, Play, Square } from "lucide-react";
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

export function CampaignRowActions({
  campaign,
}: {
  campaign: { id: string; name: string; status: string };
}) {
  const [pending, startTransition] = useTransition();
  const [endOpen, setEndOpen] = useState(false);
  const isEnded = campaign.status === "ended";

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
    <div className="flex items-center gap-0.5">
      {campaign.status === "active" ? (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Pause ${campaign.name}`}
          disabled={pending}
          onClick={() => run("paused", () => pauseCampaign(campaign.id))}
        >
          <Pause className="size-4" />
        </Button>
      ) : null}
      {campaign.status === "paused" ? (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Resume ${campaign.name}`}
          disabled={pending}
          onClick={() => run("resumed", () => resumeCampaign(campaign.id))}
        >
          <Play className="size-4" />
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Clone ${campaign.name}`}
        disabled={pending}
        onClick={() => run("cloned", () => cloneCampaign(campaign.id))}
      >
        <Copy className="size-4" />
      </Button>
      {!isEnded ? (
        <AlertDialog open={endOpen} onOpenChange={setEndOpen}>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`End ${campaign.name}`}
              disabled={pending}
            >
              <Square className="size-4" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                End &ldquo;{campaign.name}&rdquo;?
              </AlertDialogTitle>
              <AlertDialogDescription>
                Ending stops the campaign permanently and releases its Twilio
                number back to the pool. List detachment lands with the Lists
                tab in the next step.
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
