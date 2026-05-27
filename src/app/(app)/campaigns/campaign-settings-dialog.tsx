"use client";

import { useState, useTransition } from "react";
import { ChevronDown, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { createCampaign, updateCampaign } from "@/lib/campaigns/actions";
import { setCampaignLists } from "@/lib/campaigns/list-attachments-actions";

import { TestCallTab } from "./test-call-tab";

type Option = { id: string; name: string };

export type TwilioOption = {
  id: string;
  phone_number: string;
  friendly_name: string | null;
};

export type CampaignData = {
  id: string;
  name: string;
  description: string | null;
  agent_id: string;
  goal_id: string;
  twilio_number_id: string | null;
  calling_hours_start: string;
  calling_hours_end: string;
  calls_per_hour_cap: number;
  calls_per_day_cap: number;
  concurrency_cap_per_user: number;
  transfer_destination_phone: string | null;
  daily_spend_cap: number | null;
  monthly_spend_cap: number | null;
};

const NO_NUMBER = "__none__";

/** Trim a "09:00:00" Postgres time to "09:00" for the HTML time input. */
function timeForInput(value: string | null | undefined): string {
  if (!value) return "09:00";
  return value.slice(0, 5);
}

export function CampaignSettingsDialog({
  mode,
  campaign,
  agents,
  goals,
  twilioNumbers,
  kbsByAgent,
  eligibleLists,
  currentListIds,
  trigger,
}: {
  mode: "create" | "edit";
  campaign?: CampaignData;
  agents: Option[];
  goals: Option[];
  twilioNumbers: TwilioOption[];
  kbsByAgent: Record<string, Option[]>;
  eligibleLists: Option[];
  currentListIds: string[];
  /** Override the default Edit / New campaign trigger. Lets the
   *  campaigns table use the campaign name itself as the click
   *  target so opening settings doesn't require hunting for an
   *  Edit button. Falls back to the built-in trigger when omitted. */
  trigger?: React.ReactNode;
}) {
  const isEdit = mode === "edit";
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const [name, setName] = useState(campaign?.name ?? "");
  const [description, setDescription] = useState(campaign?.description ?? "");
  const [agentId, setAgentId] = useState(
    campaign?.agent_id ?? agents[0]?.id ?? "",
  );
  const [goalId, setGoalId] = useState(campaign?.goal_id ?? goals[0]?.id ?? "");
  const [twilioNumberId, setTwilioNumberId] = useState(
    campaign?.twilio_number_id ?? NO_NUMBER,
  );
  const [callingHoursStart, setCallingHoursStart] = useState(
    timeForInput(campaign?.calling_hours_start ?? "09:00"),
  );
  const [callingHoursEnd, setCallingHoursEnd] = useState(
    timeForInput(campaign?.calling_hours_end ?? "21:00"),
  );
  const [callsPerHourCap, setCallsPerHourCap] = useState(
    String(campaign?.calls_per_hour_cap ?? 30),
  );
  const [callsPerDayCap, setCallsPerDayCap] = useState(
    String(campaign?.calls_per_day_cap ?? 300),
  );
  const [concurrencyCapPerUser, setConcurrencyCapPerUser] = useState(
    String(campaign?.concurrency_cap_per_user ?? 2),
  );
  const [transferDestinationPhone, setTransferDestinationPhone] = useState(
    campaign?.transfer_destination_phone ?? "",
  );
  const [dailySpendCap, setDailySpendCap] = useState(
    campaign?.daily_spend_cap != null ? String(campaign.daily_spend_cap) : "",
  );
  const [monthlySpendCap, setMonthlySpendCap] = useState(
    campaign?.monthly_spend_cap != null
      ? String(campaign.monthly_spend_cap)
      : "",
  );
  const [selectedListIds, setSelectedListIds] =
    useState<string[]>(currentListIds);

  // Numbers eligible for THIS campaign: include this campaign's current
  // number even if it's flagged as attached.
  const eligibleNumbers = twilioNumbers;

  const agentKbs = kbsByAgent[agentId] ?? [];

  function submit() {
    startTransition(async () => {
      const input = {
        name,
        description,
        agentId,
        goalId,
        twilioNumberId: twilioNumberId === NO_NUMBER ? "" : twilioNumberId,
        callingHoursStart,
        callingHoursEnd,
        callsPerHourCap,
        callsPerDayCap,
        concurrencyCapPerUser,
        transferDestinationPhone,
        dailySpendCap,
        monthlySpendCap,
      };
      const result =
        isEdit && campaign
          ? await updateCampaign(campaign.id, input)
          : await createCampaign(input);
      if (result.error) {
        toast.error(result.error);
        return;
      }

      // Sync the Lists tab selection. The campaign exists now in both
      // create and edit modes.
      const targetId = result.campaignId;
      if (targetId) {
        const listResult = await setCampaignLists({
          campaignId: targetId,
          listIds: selectedListIds,
        });
        if (listResult.error) {
          toast.error(listResult.error);
          return;
        }
      }

      toast.success(isEdit ? "Campaign updated." : "Campaign created.");
      setOpen(false);
      if (!isEdit) {
        setName("");
        setDescription("");
        setTwilioNumberId(NO_NUMBER);
        setTransferDestinationPhone("");
        setDailySpendCap("");
        setMonthlySpendCap("");
        setSelectedListIds([]);
      }
    });
  }

  function toggleList(id: string) {
    setSelectedListIds((ids) =>
      ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
    );
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        {trigger ? (
          trigger
        ) : isEdit ? (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Edit ${campaign?.name ?? "campaign"}`}
          >
            <Pencil className="size-4" />
            Edit
          </Button>
        ) : (
          <Button>
            <Plus className="size-4" />
            New campaign
          </Button>
        )}
      </SheetTrigger>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-[640px]"
      >
        <SheetHeader className="border-border border-b">
          <SheetTitle>{isEdit ? "Edit campaign" : "New campaign"}</SheetTitle>
          <SheetDescription>
            A campaign ties a list of leads to an agent, a number, and a goal.
          </SheetDescription>
        </SheetHeader>

        {/* Scrollable middle — every section is a collapsible <details>
            so the user can scan section headers and only open the one
            they want to edit. General is open by default. */}
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-6">
          <CampaignSection title="General" defaultOpen>
            <div className="flex flex-col gap-2">
              <Label htmlFor="campaign-name">Name</Label>
              <Input
                id="campaign-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="campaign-description">Description</Label>
              <Textarea
                id="campaign-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={3}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="campaign-daily">Daily spend cap ($)</Label>
                <Input
                  id="campaign-daily"
                  type="number"
                  value={dailySpendCap}
                  onChange={(event) => setDailySpendCap(event.target.value)}
                  placeholder="Optional"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="campaign-monthly">Monthly spend cap ($)</Label>
                <Input
                  id="campaign-monthly"
                  type="number"
                  value={monthlySpendCap}
                  onChange={(event) => setMonthlySpendCap(event.target.value)}
                  placeholder="Optional"
                />
              </div>
            </div>
          </CampaignSection>

          <CampaignSection title="Agent">
            <div className="flex flex-col gap-2">
              <Label htmlFor="campaign-agent">Agent</Label>
              {agents.length > 0 ? (
                <Select value={agentId} onValueChange={setAgentId}>
                  <SelectTrigger id="campaign-agent">
                    <SelectValue placeholder="Choose an agent" />
                  </SelectTrigger>
                  <SelectContent>
                    {agents.map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        {agent.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-muted-foreground text-sm">
                  No agents yet. Build one in Settings → Agents.
                </p>
              )}
            </div>
          </CampaignSection>

          <CampaignSection title="Telephony">
            <div className="flex flex-col gap-2">
              <Label htmlFor="campaign-twilio">Twilio number</Label>
              {eligibleNumbers.length > 0 ? (
                <Select
                  value={twilioNumberId}
                  onValueChange={setTwilioNumberId}
                >
                  <SelectTrigger id="campaign-twilio">
                    <SelectValue placeholder="Choose a number" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_NUMBER}>
                      No number attached
                    </SelectItem>
                    {eligibleNumbers.map((number) => (
                      <SelectItem key={number.id} value={number.id}>
                        {number.friendly_name || number.phone_number}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-muted-foreground text-sm">
                  No numbers available. An admin can buy or release one on
                  Settings → Twilio numbers.
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="campaign-hours-start">
                  Calling hours start
                </Label>
                <Input
                  id="campaign-hours-start"
                  type="time"
                  value={callingHoursStart}
                  onChange={(event) => setCallingHoursStart(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="campaign-hours-end">Calling hours end</Label>
                <Input
                  id="campaign-hours-end"
                  type="time"
                  value={callingHoursEnd}
                  onChange={(event) => setCallingHoursEnd(event.target.value)}
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="campaign-cph">Calls / hour</Label>
                <Input
                  id="campaign-cph"
                  type="number"
                  value={callsPerHourCap}
                  onChange={(event) => setCallsPerHourCap(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="campaign-cpd">Calls / day</Label>
                <Input
                  id="campaign-cpd"
                  type="number"
                  value={callsPerDayCap}
                  onChange={(event) => setCallsPerDayCap(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="campaign-concur">Per-user concurrency</Label>
                <Input
                  id="campaign-concur"
                  type="number"
                  min={1}
                  max={5}
                  value={concurrencyCapPerUser}
                  onChange={(event) =>
                    setConcurrencyCapPerUser(event.target.value)
                  }
                />
              </div>
            </div>
          </CampaignSection>

          <CampaignSection title="Tools">
            <p className="text-muted-foreground text-sm">
              Calendly and Close integrations land in Phase 8. The agent tools
              they enable (book appointment, send email) become configurable
              here then.
            </p>
            <div className="flex flex-col gap-2">
              <Label htmlFor="campaign-transfer">
                Transfer destination phone
              </Label>
              <Input
                id="campaign-transfer"
                type="tel"
                value={transferDestinationPhone}
                onChange={(event) =>
                  setTransferDestinationPhone(event.target.value)
                }
                placeholder="+1…  (E.164)"
              />
              <p className="text-muted-foreground text-xs">
                When set, the agent gains the &ldquo;transfer to a human&rdquo;
                tool.
              </p>
            </div>
          </CampaignSection>

          <CampaignSection title="Knowledge base">
            <p className="text-muted-foreground text-sm">
              Knowledge bases are configured on the agent. This campaign
              inherits the selected agent&rsquo;s knowledge bases.
            </p>
            {agentKbs.length > 0 ? (
              <ul className="flex flex-col gap-1 text-sm">
                {agentKbs.map((kb) => (
                  <li key={kb.id} className="text-foreground">
                    • {kb.name}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground text-sm">
                The selected agent has no knowledge bases attached.
              </p>
            )}
          </CampaignSection>

          <CampaignSection title="Lists">
            <p className="text-muted-foreground text-sm">
              Lists attached to this campaign get dialed when it runs. A list
              can be attached to only one active campaign at a time.
            </p>
            {eligibleLists.length > 0 ? (
              <div className="flex flex-col gap-2">
                {eligibleLists.map((list) => (
                  <div key={list.id} className="flex items-center gap-2">
                    <Checkbox
                      id={`campaign-list-${list.id}`}
                      checked={selectedListIds.includes(list.id)}
                      onCheckedChange={() => toggleList(list.id)}
                    />
                    <Label
                      htmlFor={`campaign-list-${list.id}`}
                      className="font-normal"
                    >
                      {list.name}
                    </Label>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">
                No unattached lists. Create one on Settings → Lists, or detach
                an existing attachment first.
              </p>
            )}
          </CampaignSection>

          <CampaignSection title="Goal">
            <div className="flex flex-col gap-2">
              <Label htmlFor="campaign-goal">Goal</Label>
              {goals.length > 0 ? (
                <Select value={goalId} onValueChange={setGoalId}>
                  <SelectTrigger id="campaign-goal">
                    <SelectValue placeholder="Choose a goal" />
                  </SelectTrigger>
                  <SelectContent>
                    {goals.map((goal) => (
                      <SelectItem key={goal.id} value={goal.id}>
                        {goal.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-muted-foreground text-sm">
                  No goals yet. Add one on the Goals page.
                </p>
              )}
            </div>
          </CampaignSection>

          {isEdit ? (
            <CampaignSection title="Test">
              {/*
                liveMode is hard-wired to false for now — live ElevenLabs
                browser calls are a safety-rail item. Flip this to
                process.env.NEXT_PUBLIC_ELEVENLABS_LIVE === "live" once the
                convai SDK wiring lands.
              */}
              <TestCallTab liveMode={false} />
            </CampaignSection>
          ) : null}
        </div>

        {/* Sticky footer so Save changes is always reachable, no matter
            which section is expanded or how far the user scrolled. */}
        <SheetFooter className="border-border border-t">
          <Button onClick={submit} disabled={pending}>
            {pending ? "Saving…" : isEdit ? "Save changes" : "Create campaign"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/** Collapsible section inside the campaign-settings drawer. Same native
 *  <details> pattern used by the lead detail modal — no library, no
 *  state to manage, fully keyboard- and screen-reader-friendly. */
function CampaignSection({
  title,
  defaultOpen,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details
      open={defaultOpen}
      data-testid={`campaign-section-${title.toLowerCase().replace(/\s+/g, "-")}`}
      className="border-border group rounded-lg border"
    >
      <summary className="hover:bg-muted/50 flex cursor-pointer list-none items-center justify-between rounded-lg px-3 py-2 transition-colors">
        <span className="text-foreground text-sm font-semibold">{title}</span>
        <ChevronDown className="text-muted-foreground size-4 transition-transform group-open:rotate-180" />
      </summary>
      <div className="flex flex-col gap-4 px-3 pt-3 pb-4">{children}</div>
    </details>
  );
}
