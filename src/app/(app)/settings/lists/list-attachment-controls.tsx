"use client";

import { useState, useTransition } from "react";
import { Link2, Unlink2 } from "lucide-react";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  attachListToCampaign,
  detachList,
} from "@/lib/campaigns/list-attachments-actions";

type CampaignOption = { id: string; name: string };

export function ListAttachmentControls({
  list,
  attachedCampaigns,
  campaigns,
}: {
  list: { id: string; name: string };
  /** Every active campaign this list is currently attached to. A list can now
   *  be shared across more than one active campaign. */
  attachedCampaigns: CampaignOption[];
  campaigns: CampaignOption[];
}) {
  const [open, setOpen] = useState(false);
  const [campaignId, setCampaignId] = useState(campaigns[0]?.id ?? "");
  const [pending, startTransition] = useTransition();
  const isShared = attachedCampaigns.length >= 2;

  function attach() {
    if (!campaignId) return;
    startTransition(async () => {
      const result = await attachListToCampaign({
        listId: list.id,
        campaignId,
      });
      if (result.error) toast.error(result.error);
      else {
        toast.success("List attached to campaign.");
        setOpen(false);
      }
    });
  }

  // detachList() already detaches a list from EVERY campaign it's attached
  // to in one call — the toast just needs to say so when there's more than
  // one, since a shared list's Detach affects all of them at once.
  function detach() {
    startTransition(async () => {
      const result = await detachList(list.id);
      if (result.error) toast.error(result.error);
      else if (isShared)
        toast.success(`Detached from ${attachedCampaigns.length} campaigns.`);
      else toast.success("List detached.");
    });
  }

  // Single-campaign list — unchanged from before sharing existed: an
  // immediate detach, no confirmation step.
  if (attachedCampaigns.length === 1) {
    const attachedCampaign = attachedCampaigns[0];
    return (
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Detach ${list.name} from ${attachedCampaign.name}`}
        disabled={pending}
        onClick={detach}
      >
        <Unlink2 className="size-4" />
        Detach
      </Button>
    );
  }

  // Shared list (2+ active campaigns) — name them, and require confirmation
  // before detaching since one click now releases every one of them at once.
  if (isShared) {
    const names = attachedCampaigns.map((c) => c.name).join(", ");
    return (
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground text-xs">Shared: {names}</span>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Detach ${list.name} from all ${attachedCampaigns.length} campaigns`}
              disabled={pending}
            >
              <Unlink2 className="size-4" />
              Detach all
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Detach &ldquo;{list.name}&rdquo; from all{" "}
                {attachedCampaigns.length} campaigns?
              </AlertDialogTitle>
              <AlertDialogDescription>
                Their unfinished leads go back to the shared pool.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={detach} disabled={pending}>
                Detach
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );
  }

  if (campaigns.length === 0) {
    return <span className="text-muted-foreground text-sm">No campaigns</span>;
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Attach ${list.name} to a campaign`}
        >
          <Link2 className="size-4" />
          Attach
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Attach &ldquo;{list.name}&rdquo;</DialogTitle>
          <DialogDescription>
            Pick a campaign to attach this list to.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="attach-campaign">Campaign</Label>
          <Select value={campaignId} onValueChange={setCampaignId}>
            <SelectTrigger id="attach-campaign">
              <SelectValue placeholder="Choose a campaign" />
            </SelectTrigger>
            <SelectContent>
              {campaigns.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button onClick={attach} disabled={pending || !campaignId}>
            {pending ? "Attaching…" : "Attach"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
