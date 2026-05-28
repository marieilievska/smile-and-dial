"use client";

import { Check, ChevronDown, Megaphone, X } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { setActiveCampaign } from "@/lib/active-campaign/actions";

export type ActiveCampaignOption = {
  id: string;
  name: string;
  status: string;
};

/** Top-bar chip that shows the operator's currently active campaign
 *  and lets them switch. Manual call actions (Call Now on lead detail,
 *  future quick-dial buttons, anywhere we need a default campaign +
 *  agent + Twilio number pair) read this preference and skip the
 *  "pick a campaign" step.
 *
 *  Empty state: a muted "No active campaign" pill that opens the
 *  picker — same affordance, different label. */
export function ActiveCampaignChip({
  activeCampaign,
  campaigns,
}: {
  activeCampaign: { id: string; name: string } | null;
  campaigns: ActiveCampaignOption[];
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function pick(id: string | null) {
    startTransition(async () => {
      const result = await setActiveCampaign(id);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success(
        id
          ? `Active campaign set${id !== activeCampaign?.id ? "." : " (unchanged)."}`
          : "Active campaign cleared.",
      );
      setOpen(false);
    });
  }

  const activeStatus = campaigns.find(
    (c) => c.id === activeCampaign?.id,
  )?.status;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="hidden h-8 max-w-[14rem] gap-2 px-2.5 md:inline-flex"
          disabled={pending}
          aria-label={
            activeCampaign
              ? `Active campaign: ${activeCampaign.name}. Change campaign.`
              : "Pick an active campaign"
          }
        >
          <Megaphone className="text-primary size-3.5 shrink-0" />
          <span className="truncate text-xs">
            {activeCampaign?.name ?? "No active campaign"}
          </span>
          {activeStatus && activeStatus !== "active" ? (
            <span className="bg-warning/10 text-warning hidden rounded-full px-1.5 py-0 text-[10px] font-medium uppercase lg:inline">
              {activeStatus}
            </span>
          ) : null}
          <ChevronDown className="text-muted-foreground size-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="text-muted-foreground text-[10px] font-semibold tracking-[0.16em] uppercase">
          Active campaign
        </DropdownMenuLabel>
        <p className="text-muted-foreground -mt-1 px-2 pb-2 text-xs">
          Manual calls use this campaign&apos;s agent and Twilio number
          automatically.
        </p>
        <DropdownMenuSeparator />
        {campaigns.length === 0 ? (
          <p className="text-muted-foreground px-2 py-3 text-xs">
            No campaigns available. Create one under{" "}
            <span className="font-medium">Campaigns</span> first.
          </p>
        ) : (
          campaigns.map((c) => {
            const isActive = c.id === activeCampaign?.id;
            return (
              <DropdownMenuItem
                key={c.id}
                onClick={() => pick(c.id)}
                className="flex items-center justify-between gap-2"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    aria-hidden
                    className={`size-1.5 rounded-full ${
                      c.status === "active"
                        ? "bg-success"
                        : c.status === "paused"
                          ? "bg-warning"
                          : "bg-muted-foreground/50"
                    }`}
                  />
                  <span className="truncate text-sm">{c.name}</span>
                </span>
                {isActive ? (
                  <Check className="text-primary size-4 shrink-0" />
                ) : null}
              </DropdownMenuItem>
            );
          })
        )}
        {activeCampaign ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => pick(null)}
              className="text-muted-foreground"
            >
              <X className="size-3.5" />
              Clear active campaign
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
