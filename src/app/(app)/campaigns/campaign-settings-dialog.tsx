"use client";

import {
  BookOpen,
  ChevronDown,
  Clock,
  Headset,
  ListChecks,
  PhoneCall,
  PlayCircle,
  Sliders,
  Target,
  User,
} from "lucide-react";
import { useState, useTransition } from "react";
import { Pencil, Plus } from "lucide-react";
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
      {/* Round 15 — matched the call-detail modal width (min(58vw,
          900px)). Important: shadcn defaults Sheet to
          data-[side=right]:sm:max-w-sm; we need the same data-attr
          selector to win specificity. */}
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 data-[side=right]:sm:max-w-[min(58vw,900px)]"
      >
        <SheetHeader className="border-border animate-in fade-in slide-in-from-top-1 border-b px-6 pt-6 pb-4 duration-300">
          <SheetTitle className="text-xl">
            {isEdit ? (
              <span className="text-foreground inline-flex items-center gap-2">
                <span>Edit</span>
                <span className="text-foreground/60 text-base font-normal">
                  ·
                </span>
                <span>{campaign?.name ?? "Campaign"}</span>
              </span>
            ) : (
              "New campaign"
            )}
          </SheetTitle>
          <SheetDescription>
            A campaign ties leads to an agent, a goal, a Twilio number, and
            calling caps. Each section can be expanded independently — only the
            ones you change get saved.
          </SheetDescription>
        </SheetHeader>

        {/* Scrollable middle — every section is a collapsible <details>
            so the user can scan section headers and only open the one
            they want to edit. General + Telephony default open since
            they're the most-touched. */}
        <div className="animate-in fade-in flex flex-1 flex-col gap-3 overflow-y-auto px-6 py-5 duration-300">
          <CampaignSection
            title="General"
            icon={<Sliders className="size-4" />}
            defaultOpen
          >
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

          <CampaignSection title="Agent" icon={<User className="size-4" />}>
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

          <CampaignSection
            title="Telephony"
            icon={<PhoneCall className="size-4" />}
            defaultOpen
          >
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
            <div className="flex flex-col gap-2">
              <div className="text-muted-foreground inline-flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.16em] uppercase">
                <Clock className="size-3.5 text-[color:var(--coral)]" />
                Calling hours
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label
                    htmlFor="campaign-hours-start"
                    className="text-xs font-normal"
                  >
                    From
                  </Label>
                  <Input
                    id="campaign-hours-start"
                    type="time"
                    value={callingHoursStart}
                    onChange={(event) =>
                      setCallingHoursStart(event.target.value)
                    }
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label
                    htmlFor="campaign-hours-end"
                    className="text-xs font-normal"
                  >
                    To
                  </Label>
                  <Input
                    id="campaign-hours-end"
                    type="time"
                    value={callingHoursEnd}
                    onChange={(event) => setCallingHoursEnd(event.target.value)}
                  />
                </div>
              </div>
              <p className="text-muted-foreground text-xs">
                The dialer won&apos;t start new calls outside this window
                (lead-local time).
              </p>
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

          <CampaignSection title="Tools" icon={<Headset className="size-4" />}>
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

          <CampaignSection
            title="Knowledge base"
            icon={<BookOpen className="size-4" />}
          >
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

          <CampaignSection
            title="Lists"
            icon={<ListChecks className="size-4" />}
          >
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

          <CampaignSection title="Goal" icon={<Target className="size-4" />}>
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
            <CampaignSection
              title="Test"
              icon={<PlayCircle className="size-4" />}
            >
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

        {/* Sticky footer so Save changes is always reachable, no
            matter which section is expanded or how far the user
            scrolled. Save is coral — same primary treatment as the
            Call again button on the call detail modal. */}
        <SheetFooter className="border-border bg-card flex flex-row items-center justify-end gap-2 border-t px-6 py-4">
          <Button
            onClick={submit}
            disabled={pending}
            className="bg-[color:var(--coral)] text-white hover:bg-[color:var(--coral)]/90"
          >
            {pending ? "Saving…" : isEdit ? "Save changes" : "Create campaign"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/** Collapsible section inside the campaign-settings drawer. Native
 *  <details>/<summary> — no library, no state to manage, full
 *  keyboard + screen-reader support.
 *
 *  Round 15 — added an `icon` slot so each section reads with a
 *  consistent coral glyph + uppercase letter-spaced title, matching
 *  the rest of the app's section header convention. */
function CampaignSection({
  title,
  icon,
  defaultOpen,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details
      open={defaultOpen}
      data-testid={`campaign-section-${title.toLowerCase().replace(/\s+/g, "-")}`}
      className="border-border group bg-card rounded-lg border"
    >
      <summary className="hover:bg-muted/40 flex cursor-pointer list-none items-center justify-between rounded-lg px-4 py-3 transition-colors">
        <span className="text-foreground inline-flex items-center gap-2 text-sm font-semibold">
          {icon ? (
            <span className="text-[color:var(--coral)]">{icon}</span>
          ) : null}
          {title}
        </span>
        <ChevronDown className="text-muted-foreground size-4 transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-border/60 flex flex-col gap-4 border-t px-4 pt-4 pb-4">
        {children}
      </div>
    </details>
  );
}
