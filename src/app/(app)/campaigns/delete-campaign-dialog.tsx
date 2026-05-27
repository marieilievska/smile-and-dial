"use client";

import { useTransition } from "react";
import { Trash2 } from "lucide-react";
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
import { deleteCampaign } from "@/lib/campaigns/actions";

export function DeleteCampaignDialog({
  campaign,
}: {
  campaign: { id: string; name: string };
}) {
  const [pending, startTransition] = useTransition();

  function onConfirm() {
    startTransition(async () => {
      try {
        const result = await deleteCampaign(campaign.id);
        if (result.error) toast.error(result.error);
        else toast.success("Campaign deleted.");
      } catch {
        toast.error("Something went wrong. Please try again.");
      }
    });
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Delete ${campaign.name}`}
          className="text-destructive hover:bg-destructive/10 hover:text-destructive h-7 px-2"
        >
          <Trash2 className="size-3.5" />
          Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete &ldquo;{campaign.name}&rdquo;?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This removes the campaign. Lists attached to it return to the
            unattached pool. This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={pending}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
