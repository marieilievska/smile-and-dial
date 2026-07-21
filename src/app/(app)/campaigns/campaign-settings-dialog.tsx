"use client";

import {
  BookOpen,
  CalendarClock,
  ChevronDown,
  Clock,
  Filter,
  PhoneCall,
  PlayCircle,
  Sliders,
  User,
} from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { Pencil, Plus } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
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
import { SearchableSelect } from "@/components/ui/searchable-select";
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
import {
  countAudienceMatches,
  countSmartListMatches,
} from "@/lib/campaigns/audience-actions";
import { setCampaignLists } from "@/lib/campaigns/list-attachments-actions";
import { stateForAreaCode } from "@/lib/dialer/nanp-states";

import { TestCallTab } from "./test-call-tab";

type Option = { id: string; name: string };

/** A number pool row for this campaign — read-only here. Attachment /
 *  detachment now happens exclusively on the Twilio numbers page. */
export type PoolNumber = {
  id: string;
  phone_number: string;
  area_code: string | null;
  pool_status: string;
  rested_until: string | null;
  flagged_for_rotation: boolean;
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
  dial_interval_seconds: number;
  transfer_destination_phone: string | null;
  daily_spend_cap: number | null;
  monthly_spend_cap: number | null;
  autopilot_enabled: boolean;
  smart_scheduling: boolean;
  calendly_event_id: string | null;
  email_template_id: string | null;
  sms_template_id: string | null;
  audience_search: string | null;
  smart_list_id: string | null;
  inbound_greeting: string | null;
};

const NO_NUMBER = "__none__";
/** Sentinel for "no Calendly event chosen" — booking is OFF for the campaign;
 *  the agent won't offer times or book (no fallback event). */
const NO_EVENT = "__none__";
/** Sentinel for "no email template" — the send_email tool only records intent. */
const NO_TEMPLATE = "__none__";
/** Sentinel for "no smart list attached". */
const NO_SMART_LIST = "__none__";

/** Trim a "09:00:00" Postgres time to "09:00" for the HTML time input. */
function timeForInput(value: string | null | undefined): string {
  if (!value) return "09:00";
  return value.slice(0, 5);
}

/** "09:00" → "9:00 AM" for the collapsed-section summary line. */
function prettyTime(value: string): string {
  const [hStr, mStr] = value.split(":");
  const h = Number(hStr);
  if (Number.isNaN(h)) return value;
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${mStr ?? "00"} ${period}`;
}

/** The unified campaign builder (create) + editor (edit). One panel, two
 *  modes: "create" opens blank with safe defaults; "edit" opens pre-filled
 *  and adds a live Test-call section. The "New campaign" button and every
 *  campaign-name click both open this same Sheet. */
export function CampaignSettingsDialog({
  mode,
  campaign,
  agents,
  goals,
  poolNumbers,
  kbsByAgent,
  eligibleLists,
  listSharedWith,
  currentListIds,
  smartLists,
  calendlyEvents,
  emailTemplates,
  smsTemplates,
  trigger,
}: {
  mode: "create" | "edit";
  campaign?: CampaignData;
  agents: Option[];
  goals: Option[];
  /** This campaign's number pool — the `twilio_numbers` rows currently
   *  attached to it. Read-only here; attach/detach on Settings → Twilio
   *  numbers. */
  poolNumbers: PoolNumber[];
  kbsByAgent: Record<string, Option[]>;
  eligibleLists: Option[];
  /** list id -> the other campaigns already dialing it, so sharing a list is
   *  visible at the moment you tick it rather than a surprise afterwards. */
  listSharedWith?: Record<string, string[]>;
  currentListIds: string[];
  /** The admin's saved smart lists, selectable as a campaign audience. */
  smartLists: Option[];
  /** The owner's synced Calendly event types; the booking tools check
   *  availability / book into the one selected here. */
  calendlyEvents: Option[];
  /** The owner's email templates; the send_email tool sends the one chosen. */
  emailTemplates: Option[];
  /** The owner's SMS templates; the send_text tool sends the one chosen. */
  smsTemplates: Option[];
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
  // Frozen: the single-number picker is gone (replaced by the read-only
  // pool view below), so this value can never change post-mount. No
  // setter — keeping it as state (not a plain const) so its initial
  // value still comes from `campaign` exactly as before. Still sent
  // unchanged in submit()'s payload; see the CRITICAL SAFETY note there.
  const [twilioNumberId] = useState(campaign?.twilio_number_id ?? NO_NUMBER);
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
  const [dialIntervalSeconds, setDialIntervalSeconds] = useState(
    String(campaign?.dial_interval_seconds ?? 0),
  );
  const [transferDestinationPhone, setTransferDestinationPhone] = useState(
    campaign?.transfer_destination_phone ?? "",
  );
  const [inboundGreeting, setInboundGreeting] = useState(
    campaign?.inbound_greeting ?? "",
  );
  const [dailySpendCap, setDailySpendCap] = useState(
    campaign?.daily_spend_cap != null ? String(campaign.daily_spend_cap) : "",
  );
  const [monthlySpendCap, setMonthlySpendCap] = useState(
    campaign?.monthly_spend_cap != null
      ? String(campaign.monthly_spend_cap)
      : "",
  );
  const [autopilotEnabled, setAutopilotEnabled] = useState(
    campaign?.autopilot_enabled ?? true,
  );
  const [smartSchedulingEnabled, setSmartSchedulingEnabled] = useState(
    campaign?.smart_scheduling ?? false,
  );
  const [calendlyEventId, setCalendlyEventId] = useState(
    campaign?.calendly_event_id ?? NO_EVENT,
  );
  const [emailTemplateId, setEmailTemplateId] = useState(
    campaign?.email_template_id ?? NO_TEMPLATE,
  );
  const [smsTemplateId, setSmsTemplateId] = useState(
    campaign?.sms_template_id ?? NO_TEMPLATE,
  );
  const [selectedListIds, setSelectedListIds] =
    useState<string[]>(currentListIds);
  const [audienceSearch, setAudienceSearch] = useState(
    campaign?.audience_search ?? "",
  );
  const [audienceCount, setAudienceCount] = useState<number | null>(null);
  const [selectedSmartListId, setSelectedSmartListId] = useState(
    campaign?.smart_list_id ?? NO_SMART_LIST,
  );
  const [smartListCount, setSmartListCount] = useState<number | null>(null);

  const agentKbs = kbsByAgent[agentId] ?? [];

  // Collapsed-section summary lines, recomputed from live state so the header
  // always reflects the current (unsaved) values at a glance.
  const scheduleSummary = `${prettyTime(callingHoursStart)} – ${prettyTime(
    callingHoursEnd,
  )} · ${callsPerHourCap}/hr · ${callsPerDayCap}/day · Autopilot ${
    autopilotEnabled ? "on" : "off"
  }`;
  const numberSummary =
    poolNumbers.length === 0
      ? "No numbers"
      : `${poolNumbers.length} number${poolNumbers.length === 1 ? "" : "s"}`;
  const bookingSummary = `${
    calendlyEventId === NO_EVENT ? "No meeting" : "Books meeting"
  } · ${emailTemplateId === NO_TEMPLATE ? "No email" : "Sends email"}`;

  // Live "matches N leads" preview. Debounced so we don't fire a count on
  // every keystroke. All state writes happen inside the timeout callback (never
  // synchronously in the effect body) to avoid cascading renders. An empty
  // filter clears the count promptly (0ms); a real term waits out the debounce.
  useEffect(() => {
    const term = audienceSearch.trim();
    let cancelled = false;
    const handle = setTimeout(
      () => {
        if (cancelled) return;
        if (!term) {
          setAudienceCount(null);
          return;
        }
        void countAudienceMatches({
          search: term,
          campaignId: campaign?.id,
        }).then((result) => {
          if (!cancelled) setAudienceCount(result.count);
        });
      },
      term ? 400 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [audienceSearch, campaign?.id]);

  // Live "matches N leads" preview for the picked smart list.
  useEffect(() => {
    if (selectedSmartListId === NO_SMART_LIST) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSmartListCount(null);
      return;
    }
    let cancelled = false;
    void countSmartListMatches({ smartListId: selectedSmartListId }).then(
      (result) => {
        if (!cancelled) setSmartListCount(result.count);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [selectedSmartListId]);

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
        dialIntervalSeconds,
        transferDestinationPhone,
        inboundGreeting,
        dailySpendCap,
        monthlySpendCap,
        autopilotEnabled,
        smartSchedulingEnabled,
        calendlyEventId: calendlyEventId === NO_EVENT ? "" : calendlyEventId,
        emailTemplateId: emailTemplateId === NO_TEMPLATE ? "" : emailTemplateId,
        smsTemplateId: smsTemplateId === NO_TEMPLATE ? "" : smsTemplateId,
        audienceSearch,
        smartListId:
          selectedSmartListId === NO_SMART_LIST ? "" : selectedSmartListId,
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
        setTransferDestinationPhone("");
        setDailySpendCap("");
        setMonthlySpendCap("");
        setAutopilotEnabled(true);
        setSmartSchedulingEnabled(false);
        setCalendlyEventId(NO_EVENT);
        setEmailTemplateId(NO_TEMPLATE);
        setSmsTemplateId(NO_TEMPLATE);
        setSelectedListIds([]);
        setAudienceSearch("");
        setSelectedSmartListId(NO_SMART_LIST);
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
            {isEdit
              ? "Update any section, then save. The collapsed sections show their current settings at a glance."
              : "Fill the essentials — name, agent, and goal — to launch. Everything else has safe defaults you can tune now or later."}
          </SheetDescription>
        </SheetHeader>

        {/* Scrollable middle — collapsible sections grouped for both create
            and edit. Basics, Agent & goal, and Audience open by default
            (the launch essentials); the rest collapse with a live summary. */}
        <div className="animate-in fade-in flex flex-1 flex-col gap-3 overflow-y-auto px-6 py-5 duration-300">
          <CampaignSection
            title="Basics"
            icon={<Sliders className="size-4" />}
            defaultOpen
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="campaign-name">Name</Label>
              <Input
                id="campaign-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Q1 Outbound"
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
          </CampaignSection>

          <CampaignSection
            title="Agent & goal"
            icon={<User className="size-4" />}
            defaultOpen
          >
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

          <CampaignSection
            title="Audience"
            icon={<Filter className="size-4" />}
            defaultOpen
          >
            <div className="flex flex-col gap-2">
              <div className="text-muted-foreground text-[10px] font-semibold tracking-[0.16em] uppercase">
                Lists
              </div>
              <p className="text-muted-foreground text-sm">
                Lists attached to this campaign get dialed when it runs. The
                same list can be attached to more than one campaign — each lead
                is still only ever dialed by one of them, so they can&apos;t
                double-call.
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
                      {listSharedWith?.[list.id]?.length ? (
                        <span className="text-muted-foreground text-xs">
                          also in {listSharedWith[list.id].join(", ")}
                        </span>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">
                  No lists yet. Create one on Settings → Lists.
                </p>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="campaign-audience">
                …or company name contains
              </Label>
              <Input
                id="campaign-audience"
                value={audienceSearch}
                onChange={(event) => setAudienceSearch(event.target.value)}
                placeholder="e.g. F45"
              />
              <p className="text-muted-foreground text-xs">
                Beyond the lists above, also call every lead whose company name
                contains this text — no matter which list it was uploaded into.
                Leave blank to target only the lists above.
              </p>
              {audienceSearch.trim() ? (
                <p className="text-muted-foreground text-xs">
                  {audienceCount === null
                    ? "Counting matching leads…"
                    : `Matches ${audienceCount.toLocaleString()} lead${
                        audienceCount === 1 ? "" : "s"
                      } across all lists.`}
                </p>
              ) : null}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="campaign-smart-list">…or a smart list</Label>
              {smartLists.length > 0 ? (
                <Select
                  value={selectedSmartListId}
                  onValueChange={setSelectedSmartListId}
                >
                  <SelectTrigger id="campaign-smart-list">
                    <SelectValue placeholder="No smart list" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_SMART_LIST}>No smart list</SelectItem>
                    {smartLists.map((sl) => (
                      <SelectItem key={sl.id} value={sl.id}>
                        {sl.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-muted-foreground text-sm">
                  No smart lists yet. Build one on the Leads page (advanced
                  filters → Save as smart list).
                </p>
              )}
              <p className="text-muted-foreground text-xs">
                A smart list is a saved filter that auto-includes any new lead
                matching it. Attaching one dials its members; membership
                refreshes every few minutes.
              </p>
              {selectedSmartListId !== NO_SMART_LIST ? (
                <p className="text-muted-foreground text-xs">
                  {smartListCount === null
                    ? "Counting matching leads…"
                    : `Matches ${smartListCount.toLocaleString()} lead${
                        smartListCount === 1 ? "" : "s"
                      } right now.`}
                </p>
              ) : null}
            </div>
          </CampaignSection>

          <CampaignSection
            title="Schedule & caps"
            icon={<Clock className="size-4" />}
            summary={scheduleSummary}
          >
            <div className="flex flex-col gap-2">
              <div className="text-muted-foreground inline-flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.16em] uppercase">
                <Clock className="text-primary size-3.5" />
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
            <label
              htmlFor="campaign-autopilot"
              className="border-border hover:bg-muted/40 flex cursor-pointer items-start gap-3 rounded-lg border p-3"
            >
              <Checkbox
                id="campaign-autopilot"
                checked={autopilotEnabled}
                onCheckedChange={(v) => setAutopilotEnabled(v === true)}
                className="mt-0.5"
              />
              <div className="flex flex-col gap-0.5">
                <span className="text-foreground text-sm font-medium">
                  Autopilot — auto-dial this campaign&apos;s leads
                </span>
                <span className="text-muted-foreground text-xs">
                  On: the AI dials leads automatically during calling hours.
                  Off: nothing dials on its own, but you can still place manual
                  Call Now calls one by one.
                </span>
              </div>
            </label>
            <label
              htmlFor="campaign-smart-scheduling"
              className="border-border hover:bg-muted/40 flex cursor-pointer items-start gap-3 rounded-lg border p-3"
            >
              <Checkbox
                id="campaign-smart-scheduling"
                checked={smartSchedulingEnabled}
                onCheckedChange={(v) => setSmartSchedulingEnabled(v === true)}
                className="mt-0.5"
              />
              <div className="flex flex-col gap-0.5">
                <span className="text-foreground text-sm font-medium">
                  Smart scheduling
                </span>
                <span className="text-muted-foreground text-xs">
                  When on, retries aim for each lead&apos;s best-answering hour
                  (in their timezone) instead of a fixed time. Uses your
                  connect-rate history; falls back to mid-morning until
                  there&apos;s enough data.
                </span>
              </div>
            </label>
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
              <div className="flex flex-col gap-2">
                <Label htmlFor="campaign-dial-interval">
                  Seconds between calls
                </Label>
                <Input
                  id="campaign-dial-interval"
                  type="number"
                  min={0}
                  max={120}
                  value={dialIntervalSeconds}
                  onChange={(event) =>
                    setDialIntervalSeconds(event.target.value)
                  }
                />
                <p className="text-muted-foreground text-[11px]">
                  Space calls out instead of firing all at once. 0 = off.
                </p>
              </div>
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

          <CampaignSection
            title="Numbers & transfer"
            icon={<PhoneCall className="size-4" />}
            summary={numberSummary}
          >
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-foreground text-sm font-semibold">
                  Number pool{" "}
                  <span className="text-muted-foreground font-normal">
                    ({poolNumbers.length})
                  </span>
                </span>
                <a
                  href="/settings/twilio-numbers"
                  className="text-primary text-xs font-medium hover:underline"
                >
                  Manage numbers →
                </a>
              </div>
              {poolNumbers.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No numbers in this campaign&apos;s pool yet. Buy local numbers
                  into it from Settings → Twilio numbers.
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {poolNumbers.map((number) => (
                    <li
                      key={number.id}
                      className="border-border flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-xs"
                    >
                      <span className="text-foreground truncate">
                        {number.area_code
                          ? `${number.area_code} · ${
                              stateForAreaCode(number.area_code) ?? "—"
                            }`
                          : "—"}{" "}
                        <span className="text-muted-foreground">
                          {number.phone_number}
                        </span>
                      </span>
                      {poolNumberBadge(number)}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-muted-foreground text-xs">
                These are the numbers this campaign dials from — local presence
                first, then same state. Add or manage them on the Twilio numbers
                page.
              </p>
            </div>
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
                When set and the agent has the &ldquo;transfer to a human&rdquo;
                tool enabled, this is the number it dials.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="campaign-inbound-greeting">
                Inbound greeting
              </Label>
              <Textarea
                id="campaign-inbound-greeting"
                value={inboundGreeting}
                onChange={(event) => setInboundGreeting(event.target.value)}
                placeholder="Hi, thanks for calling! How can I help you today?"
                rows={2}
              />
              <p className="text-muted-foreground text-xs">
                The first line the agent speaks when someone calls this
                campaign&apos;s number back. Leave blank to use a standard
                greeting. (Inbound only — on outbound calls the person answers
                first.)
              </p>
            </div>
          </CampaignSection>

          <CampaignSection
            title="Booking & email"
            icon={<CalendarClock className="size-4" />}
            summary={bookingSummary}
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="campaign-calendly">Calendly event</Label>
              {calendlyEvents.length > 0 ? (
                <SearchableSelect
                  id="campaign-calendly"
                  value={calendlyEventId}
                  onValueChange={setCalendlyEventId}
                  placeholder="None — don't book a meeting"
                  searchPlaceholder="Search events…"
                  emptyText="No events match."
                  options={[
                    { value: NO_EVENT, label: "None — don't book a meeting" },
                    ...calendlyEvents.map((evt) => ({
                      value: evt.id,
                      label: evt.name,
                    })),
                  ]}
                />
              ) : (
                <p className="text-muted-foreground text-sm">
                  No Calendly events synced. Connect Calendly on Settings →
                  Integrations first.
                </p>
              )}
              <p className="text-muted-foreground text-xs">
                Leave this as &ldquo;None&rdquo; for campaigns that aren&apos;t
                booking meetings. Pick an event only when you want the agent to
                offer times and book — it checks availability for and books into
                the chosen event.
              </p>
            </div>

            <div className="mt-4 flex flex-col gap-2">
              <Label htmlFor="campaign-email-template">Email template</Label>
              {emailTemplates.length > 0 ? (
                <Select
                  value={emailTemplateId}
                  onValueChange={setEmailTemplateId}
                >
                  <SelectTrigger id="campaign-email-template">
                    <SelectValue placeholder="Choose an email template" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_TEMPLATE}>
                      None (don&apos;t send email)
                    </SelectItem>
                    {emailTemplates.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-muted-foreground text-sm">
                  No email templates yet. Create one on Settings → Email
                  templates first.
                </p>
              )}
              <p className="text-muted-foreground text-xs">
                The exact email the agent sends when it uses &ldquo;send
                email&rdquo; (variables like {"{{lead.company}}"} are filled in
                per lead).
              </p>
            </div>

            <div className="mt-4 flex flex-col gap-2">
              <Label htmlFor="campaign-sms-template">Text template</Label>
              {smsTemplates.length > 0 ? (
                <Select value={smsTemplateId} onValueChange={setSmsTemplateId}>
                  <SelectTrigger id="campaign-sms-template">
                    <SelectValue placeholder="Choose a text template" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_TEMPLATE}>
                      None (don&apos;t send text)
                    </SelectItem>
                    {smsTemplates.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-muted-foreground text-sm">
                  No text templates yet. Create one on Settings → Text templates
                  first.
                </p>
              )}
              <p className="text-muted-foreground text-xs">
                The text the agent sends when it uses &ldquo;send text&rdquo;
                (to a confirmed mobile; an opt-out line is always appended).
                Needs the agent&apos;s &ldquo;Send text&rdquo; tool enabled.
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

          {isEdit && campaign ? (
            <CampaignSection
              title="Test"
              icon={<PlayCircle className="size-4" />}
            >
              <TestCallTab campaignId={campaign.id} />
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
            className="bg-primary hover:bg-primary/90 text-white"
          >
            {pending ? "Saving…" : isEdit ? "Save changes" : "Create campaign"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/** Collapsible section inside the campaign builder/editor. Native
 *  <details>/<summary> — no library, no state to manage, full
 *  keyboard + screen-reader support. Shows a live summary on the header
 *  when collapsed so the operator can scan settings without expanding. */
function CampaignSection({
  title,
  icon,
  summary,
  defaultOpen,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  summary?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details
      open={defaultOpen}
      data-testid={`campaign-section-${title.toLowerCase().replace(/\s+/g, "-")}`}
      className="border-border group bg-card rounded-2xl border shadow-sm"
    >
      <summary className="hover:bg-muted/40 flex cursor-pointer list-none items-center justify-between gap-3 rounded-2xl px-4 py-3 transition-colors">
        <span className="text-foreground inline-flex items-center gap-2 text-sm font-semibold">
          {icon ? <span className="text-primary">{icon}</span> : null}
          {title}
        </span>
        <span className="flex min-w-0 items-center gap-2">
          {summary ? (
            <span className="text-muted-foreground hidden truncate text-xs group-open:hidden sm:inline">
              {summary}
            </span>
          ) : null}
          <ChevronDown className="text-muted-foreground size-4 shrink-0 transition-transform group-open:rotate-180" />
        </span>
      </summary>
      <div className="border-border/60 flex flex-col gap-4 border-t px-4 pt-4 pb-4">
        {children}
      </div>
    </details>
  );
}

/** Small status pill for a pool number, shown in the read-only pool list.
 *  Simplified sibling of the Twilio numbers page's `poolStateBadge` — no
 *  warm-up state here, this view is about "is this number in rotation?"
 *  Checked in priority order: retired > flagged > rested > active. */
function poolNumberBadge(number: {
  pool_status: string;
  flagged_for_rotation: boolean;
  rested_until: string | null;
}): React.ReactNode {
  if (number.pool_status === "retired") {
    return <Badge variant="ghost">Retired</Badge>;
  }
  if (number.flagged_for_rotation) {
    return <Badge variant="warning">Flagged</Badge>;
  }
  if (number.rested_until && new Date(number.rested_until) > new Date()) {
    return <Badge variant="secondary">Rested</Badge>;
  }
  return (
    <Badge variant="success" dot>
      Active
    </Badge>
  );
}
