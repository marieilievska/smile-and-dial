import { Phone } from "lucide-react";

import { formatPhone } from "@/lib/format-phone";

import {
  attentionRail,
  CampaignStatusBadge,
  DialingNowChip,
  HoursLabel,
  ListsBadge,
  ManualOnlyChip,
  OutsideHoursChip,
  SpendCapBar,
} from "./campaign-cells";
import { CampaignNameTrigger } from "./campaign-name-trigger";
import { CampaignRowActions } from "./campaign-row-actions";
import type { CampaignData, TwilioOption } from "./campaign-settings-dialog";
import { DeleteCampaignDialog } from "./delete-campaign-dialog";

type Option = { id: string; name: string };

/** A single campaign as rendered on the board. Carries the derived
 *  live state plus the option payloads the settings dialog needs. The
 *  page builds these once (shared with the table view). */
export type CampaignCardItem = {
  data: CampaignData;
  status: string;
  agentName: string;
  goalName: string;
  twilioPhone: string | null;
  description: string | null;
  listCount: number;
  callsToday: number;
  spendToday: number;
  dailyCap: number | null;
  insideHours: boolean;
  isActive: boolean;
  autopilotEnabled: boolean;
  callingHoursStart: string | null;
  callingHoursEnd: string | null;
  twilioNumbers: TwilioOption[];
  eligibleLists: Option[];
  currentListIds: string[];
};

/** Board (card) view of campaigns — the "live operations" lens. Each
 *  card heroes what the AI is doing right now: status + a "Dialing now"
 *  pulse, calls placed today, and spend against the daily cap. Agent /
 *  goal / hours / lists are secondary config. A left attention rail
 *  flags campaigns that need a look (active but no lists, or off-hours).
 *
 *  Cards animate in with a staggered fade + slide on page load. */
export function CampaignBoard({
  campaigns,
  agents,
  goals,
  kbsByAgent,
  smartLists,
  calendlyEvents,
  emailTemplates,
}: {
  campaigns: CampaignCardItem[];
  agents: Option[];
  goals: Option[];
  kbsByAgent: Record<string, Option[]>;
  smartLists: Option[];
  calendlyEvents: Option[];
  emailTemplates: Option[];
}) {
  return (
    <div
      data-testid="campaigns-board"
      className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
    >
      {campaigns.map((c, index) => {
        const rail = attentionRail({
          isActive: c.isActive,
          insideHours: c.insideHours,
          listCount: c.listCount,
        });
        return (
          <div
            key={c.data.id}
            style={{ animationDelay: `${index * 50}ms` }}
            className={`animate-in fade-in slide-in-from-bottom-2 fill-mode-both bg-card border-border flex flex-col gap-3 rounded-2xl border border-l-[3px] p-4 shadow-sm transition-shadow duration-500 hover:shadow-md ${rail}`}
          >
            {/* Top: status + live signal */}
            <div className="flex items-center justify-between gap-2">
              <CampaignStatusBadge status={c.status} />
              {c.isActive ? (
                !c.autopilotEnabled ? (
                  <ManualOnlyChip />
                ) : c.insideHours ? (
                  <DialingNowChip />
                ) : (
                  <OutsideHoursChip />
                )
              ) : null}
            </div>

            {/* Name (settings trigger) + phone/description */}
            <div className="flex flex-col gap-0.5">
              <CampaignNameTrigger
                name={c.data.name}
                campaign={c.data}
                agents={agents}
                goals={goals}
                twilioNumbers={c.twilioNumbers}
                kbsByAgent={kbsByAgent}
                eligibleLists={c.eligibleLists}
                currentListIds={c.currentListIds}
                smartLists={smartLists}
                calendlyEvents={calendlyEvents}
                emailTemplates={emailTemplates}
              />
              {c.twilioPhone || c.description ? (
                <span className="text-muted-foreground truncate text-[11px]">
                  {c.twilioPhone ? (
                    <span className="font-mono">
                      {formatPhone(c.twilioPhone)}
                    </span>
                  ) : null}
                  {c.twilioPhone && c.description ? " · " : ""}
                  {c.description ?? ""}
                </span>
              ) : null}
            </div>

            {/* Live numbers — the hero of the card */}
            <div className="border-border/60 grid grid-cols-2 gap-3 border-t border-b py-3">
              <div className="flex flex-col gap-1">
                <span className="text-muted-foreground text-[10px] font-medium tracking-[0.14em] uppercase">
                  Calls today
                </span>
                <span className="text-foreground inline-flex items-center gap-1.5 text-lg font-medium tabular-nums">
                  <Phone className="text-muted-foreground size-3.5 shrink-0" />
                  {c.callsToday.toLocaleString()}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-muted-foreground text-[10px] font-medium tracking-[0.14em] uppercase">
                  Spend today
                </span>
                <SpendCapBar spend={c.spendToday} cap={c.dailyCap} />
              </div>
            </div>

            {/* Secondary config */}
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
              <span className="truncate">{c.agentName}</span>
              <span aria-hidden>·</span>
              <span className="truncate">{c.goalName}</span>
              <span aria-hidden>·</span>
              <HoursLabel start={c.callingHoursStart} end={c.callingHoursEnd} />
              <span aria-hidden>·</span>
              <ListsBadge count={c.listCount} />
            </div>

            {/* Actions */}
            <div className="border-border/60 flex items-center justify-between gap-1 border-t pt-3">
              <CampaignRowActions
                variant="card"
                campaign={{
                  id: c.data.id,
                  name: c.data.name,
                  status: c.status,
                }}
              />
              <DeleteCampaignDialog
                campaign={{ id: c.data.id, name: c.data.name }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
