"use client";

import { useState, useTransition } from "react";
import { Link2, Unlink2 } from "lucide-react";
import { toast } from "sonner";

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
  attachedCampaign,
  campaigns,
}: {
  list: { id: string; name: string };
  attachedCampaign: { id: string; name: string } | null;
  campaigns: CampaignOption[];
}) {
  const [open, setOpen] = useState(false);
  const [campaignId, setCampaignId] = useState(campaigns[0]?.id ?? "");
  const [pending, startTransition] = useTransition();

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

  function detach() {
    startTransition(async () => {
      const result = await detachList(list.id);
      if (result.error) toast.error(result.error);
      else toast.success("List detached.");
    });
  }

  if (attachedCampaign) {
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
