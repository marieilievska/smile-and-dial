"use client";

import {
  BookOpen,
  CalendarClock,
  ChevronDown,
  Clock,
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
  autopilot_enabled: boolean;
  smart_scheduling: boolean;
  calendly_event_id: string | null;
  email_template_id: string | null;
};

const NO_NUMBER = "__none__";
/** Sentinel for "no Calendly event chosen" — booking is OFF for the campaign;
 *  the agent won't offer times or book (no fallback event). */
const NO_EVENT = "__none__";
/** Sentinel for "no email template" — the send_email tool only records intent. */
const NO_TEMPLATE = "__none__";

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
  calendlyEvents,
  emailTemplates,
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
  /** The owner's synced Calendly event types; the booking tools check
   *  availability / book into the one selected here. */
  calendlyEvents: Option[];
  /** The owner's email templates; the send_email tool sends the one chosen. */
  emailTemplates: Option[];
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
        autopilotEnabled,
        smartSchedulingEnabled,
        calendlyEventId: calendlyEventId === NO_EVENT ? "" : calendlyEventId,
        emailTemplateId: emailTemplateId === NO_TEMPLATE ? "" : emailTemplateId,
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
        setAutopilotEnabled(true);
        setSmartSchedulingEnabled(false);
        setCalendlyEventId(NO_EVENT);
        setEmailTemplateId(NO_TEMPLATE);
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
            </div>

            {/* Transfer destination phone — moved here from the
                retired Tools section. The transfer-to-human capability
                itself lives on the agent; this is just the campaign-
                specific number the agent should dial when the user
                asks for a human. */}
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
          </CampaignSection>

          {/* Round 16 — "Tools" section retired. The agent owns its
              tool capabilities (transfer-to-human, calendly book, etc).
              The campaign only contributes the destination phone for
              the transfer tool — that's a telephony detail, so we keep
              it under Telephony above. Calendly / Close integration
              config will live on the agent edit page when Phase 8
              lands. */}

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

          <CampaignSection
            title="Booking"
            icon={<CalendarClock className="size-4" />}
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
            className="bg-primary hover:bg-primary/90 text-white"
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
          {icon ? <span className="text-primary">{icon}</span> : null}
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
