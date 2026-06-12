"use client";

import { Bot } from "lucide-react";

import { Button } from "@/components/ui/button";

import { CallNowDialog } from "../call-now-dialog";
import { ManualCallPanel } from "./manual-call-panel";

/**
 * "Call the owner" control, rendered under the Owner phone field on the lead
 * detail page when the lead has an owner_phone. Gives the same two ways to reach
 * the owner's direct line that the business line has in the hero:
 *   - AI call owner — the agent dials the owner. Reuses the Call Now campaign
 *     picker, pinned to target="owner"; the same pre-call gates run, plus a DNC
 *     check on the owner's number.
 *   - Call owner — the in-browser softphone, pointed at the owner number, so the
 *     operator talks to the owner themselves and then logs the outcome.
 */
export function OwnerCallControl({
  leadId,
  userId,
  availableCampaigns,
  initialCampaignId,
}: {
  leadId: string;
  userId: string;
  availableCampaigns: { id: string; name: string }[];
  initialCampaignId?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <CallNowDialog
        leadId={leadId}
        availableCampaigns={availableCampaigns}
        initialCampaignId={initialCampaignId}
        target="owner"
        trigger={
          <Button variant="outline" className="gap-2">
            <Bot className="size-4" />
            AI call owner
          </Button>
        }
      />
      <ManualCallPanel
        leadId={leadId}
        userId={userId}
        target="owner"
        label="Call owner"
      />
    </div>
  );
}
