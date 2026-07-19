"use client";

import { CampaignSettingsDialog } from "./campaign-settings-dialog";
import type { CampaignData, PoolNumber } from "./campaign-settings-dialog";

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
  poolNumbers,
  kbsByAgent,
  eligibleLists,
  currentListIds,
  smartLists,
  calendlyEvents,
  emailTemplates,
  smsTemplates,
}: {
  name: string;
  campaign: CampaignData;
  agents: Option[];
  goals: Option[];
  poolNumbers: PoolNumber[];
  kbsByAgent: Record<string, Option[]>;
  eligibleLists: Option[];
  currentListIds: string[];
  smartLists: Option[];
  calendlyEvents: Option[];
  emailTemplates: Option[];
  smsTemplates: Option[];
}) {
  return (
    <CampaignSettingsDialog
      mode="edit"
      campaign={campaign}
      agents={agents}
      goals={goals}
      poolNumbers={poolNumbers}
      kbsByAgent={kbsByAgent}
      eligibleLists={eligibleLists}
      currentListIds={currentListIds}
      smartLists={smartLists}
      calendlyEvents={calendlyEvents}
      emailTemplates={emailTemplates}
      smsTemplates={smsTemplates}
      trigger={
        <button
          type="button"
          className="text-foreground hover:text-primary truncate text-left text-sm font-medium underline-offset-2 hover:underline"
        >
          {name}
        </button>
      }
    />
  );
}
