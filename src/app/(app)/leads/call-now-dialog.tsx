"use client";

import { useState, useTransition } from "react";
import { PhoneCall } from "lucide-react";
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
import { callNow } from "@/lib/dialer/call-now";

/** "Call Now" button on the lead detail modal (Step 34 / BUILD_PLAN §5.1).
 *  Opens a small Select of active campaigns attached to this lead's list,
 *  then fires `callNow`. Pre-call checks still apply — a rejection comes
 *  back as a specific reason message. */
export function CallNowDialog({
  leadId,
  availableCampaigns,
}: {
  leadId: string;
  availableCampaigns: { id: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [campaignId, setCampaignId] = useState<string>(
    availableCampaigns[0]?.id ?? "",
  );
  const [pending, startTransition] = useTransition();

  function confirm() {
    if (!campaignId) return;
    startTransition(async () => {
      const result = await callNow({ leadId, campaignId });
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success("Call placed.");
      setOpen(false);
    });
  }

  const disabled = availableCampaigns.length === 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" disabled={disabled}>
          <PhoneCall className="size-4" />
          Call now
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Call this lead now</DialogTitle>
          <DialogDescription>
            Pick which campaign to dial under. The pre-call check still runs —
            DNC, calling hours, caps, and concurrency all apply.
          </DialogDescription>
        </DialogHeader>
        {disabled ? (
          <p className="text-muted-foreground text-sm">
            No active campaigns have this lead&apos;s list attached. Attach it
            from a campaign&apos;s settings first.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <Label htmlFor="call-now-campaign">Campaign</Label>
            <Select value={campaignId} onValueChange={setCampaignId}>
              <SelectTrigger id="call-now-campaign">
                <SelectValue placeholder="Pick a campaign" />
              </SelectTrigger>
              <SelectContent>
                {availableCampaigns.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <DialogFooter>
          <Button
            onClick={confirm}
            disabled={disabled || !campaignId || pending}
          >
            {pending ? "Dialing…" : "Call"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
