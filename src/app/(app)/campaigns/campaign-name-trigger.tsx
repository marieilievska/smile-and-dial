"use client";

import { CampaignSettingsDialog } from "./campaign-settings-dialog";
import type { CampaignData, TwilioOption } from "./campaign-settings-dialog";

type Option = { id: string; name: string };

/** Wraps the campaign name in a settings-dialog trigger.
 *
 *  Round 14 — extracted into its own client module to dodge a Next 16
 *  / React 19 hydration mismatch. When the dialog was inlined inside
 *  the server-rendered TableCell and consumed `asChild` on the
 *  trigger, SSR and client rendered slightly different child trees
 *  for the SheetTrigger Slot, blowing hydration. A dedicated client
 *  boundary fixes that without changing the visible behavior. */
export function CampaignNameTrigger({
  name,
  campaign,
  agents,
  goals,
  twilioNumbers,
  kbsByAgent,
  eligibleLists,
  currentListIds,
}: {
  name: string;
  campaign: CampaignData;
  agents: Option[];
  goals: Option[];
  twilioNumbers: TwilioOption[];
  kbsByAgent: Record<string, Option[]>;
  eligibleLists: Option[];
  currentListIds: string[];
}) {
  return (
    <CampaignSettingsDialog
      mode="edit"
      campaign={campaign}
      agents={agents}
      goals={goals}
      twilioNumbers={twilioNumbers}
      kbsByAgent={kbsByAgent}
      eligibleLists={eligibleLists}
      currentListIds={currentListIds}
      trigger={
        <button
          type="button"
          className="text-foreground truncate text-left text-sm font-medium underline-offset-2 hover:text-[color:var(--coral)] hover:underline"
        >
          {name}
        </button>
      }
    />
  );
}
