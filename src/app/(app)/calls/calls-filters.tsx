"use client";

import { Filter } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CALL_STATUS_LABELS,
  OUTCOME_LABELS,
  callStatusLabel,
  outcomeLabel,
} from "@/lib/labels";

type Campaign = { id: string; name: string };
type Agent = { id: string; name: string };
type Owner = { id: string; name: string };

/** Filter keys that count toward the "active filters" badge on the
 *  popover trigger. */
const FILTER_KEYS = [
  "direction",
  "status",
  "outcome",
  "campaign",
  "agent",
  "owner",
  "goal_met",
  "min_dur",
  "max_dur",
  "from",
  "to",
] as const;

/** URL-driven filter popover for the Calls table. Grouped into three
 *  visual sections (Call · Where · When) so pairs read together
 *  instead of orphaning Min/Max or the date range across rows. */
export function CallsFilters({
  campaigns,
  agents,
  owners,
  showOwner,
}: {
  campaigns: Campaign[];
  agents: Agent[];
  owners: Owner[];
  /** Owner filter only appears for admins (members can only see their
   *  own calls anyway). */
  showOwner: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);

  const get = (key: string) => searchParams.get(key) ?? "";
  const [direction, setDirection] = useState(get("direction") || "any");
  const [status, setStatus] = useState(get("status") || "any");
  const [outcome, setOutcome] = useState(get("outcome") || "any");
  const [campaign, setCampaign] = useState(get("campaign") || "any");
  const [agent, setAgent] = useState(get("agent") || "any");
  const [owner, setOwner] = useState(get("owner") || "any");
  const [goalMet, setGoalMet] = useState(get("goal_met") || "any");
  const [minDur, setMinDur] = useState(get("min_dur"));
  const [maxDur, setMaxDur] = useState(get("max_dur"));
  const [from, setFrom] = useState(get("from"));
  const [to, setTo] = useState(get("to"));

  const activeCount = FILTER_KEYS.filter((key) =>
    searchParams.get(key as string),
  ).length;

  function apply() {
    const params = new URLSearchParams(searchParams.toString());
    const set = (key: string, value: string) => {
      if (value && value !== "any") params.set(key, value);
      else params.delete(key);
    };
    set("direction", direction);
    set("status", status);
    set("outcome", outcome);
    set("campaign", campaign);
    set("agent", agent);
    set("owner", owner);
    set("goal_met", goalMet);
    set("min_dur", minDur);
    set("max_dur", maxDur);
    set("from", from);
    set("to", to);
    params.delete("page");
    router.push(`/calls?${params.toString()}`);
    setOpen(false);
  }

  function clear() {
    const params = new URLSearchParams(searchParams.toString());
    for (const key of FILTER_KEYS) params.delete(key as string);
    params.delete("page");
    setDirection("any");
    setStatus("any");
    setOutcome("any");
    setCampaign("any");
    setAgent("any");
    setOwner("any");
    setGoalMet("any");
    setMinDur("");
    setMaxDur("");
    setFrom("");
    setTo("");
    router.push(`/calls?${params.toString()}`);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline">
          <Filter className="size-4" />
          Filters
          {activeCount > 0 ? (
            <Badge variant="secondary">{activeCount}</Badge>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="flex w-[min(520px,92vw)] flex-col gap-5"
      >
        <Section title="Call">
          <div className="grid grid-cols-2 gap-3">
            <Pickable
              label="Direction"
              value={direction}
              onChange={setDirection}
              options={[
                { value: "any", label: "Any" },
                { value: "outbound", label: "Outbound" },
                { value: "inbound", label: "Inbound" },
              ]}
            />
            <Pickable
              label="Outcome"
              value={outcome}
              onChange={setOutcome}
              options={[
                { value: "any", label: "Any" },
                ...Object.keys(OUTCOME_LABELS).map((k) => ({
                  value: k,
                  label: outcomeLabel(k),
                })),
              ]}
            />
            <Pickable
              label="Goal met"
              value={goalMet}
              onChange={setGoalMet}
              options={[
                { value: "any", label: "Any" },
                { value: "yes", label: "Yes" },
                { value: "no", label: "No" },
              ]}
            />
            <Pickable
              label="Status"
              value={status}
              onChange={setStatus}
              options={[
                { value: "any", label: "Any" },
                ...Object.keys(CALL_STATUS_LABELS).map((k) => ({
                  value: k,
                  label: callStatusLabel(k),
                })),
              ]}
            />
          </div>
        </Section>

        <Section title="Where">
          <div className="grid grid-cols-2 gap-3">
            <Pickable
              label="Campaign"
              value={campaign}
              onChange={setCampaign}
              options={[
                { value: "any", label: "Any campaign" },
                ...campaigns.map((c) => ({ value: c.id, label: c.name })),
              ]}
            />
            <Pickable
              label="Agent"
              value={agent}
              onChange={setAgent}
              options={[
                { value: "any", label: "Any agent" },
                ...agents.map((a) => ({ value: a.id, label: a.name })),
              ]}
            />
            {showOwner ? (
              <div className="col-span-2">
                <Pickable
                  label="Owner"
                  value={owner}
                  onChange={setOwner}
                  options={[
                    { value: "any", label: "Any owner" },
                    ...owners.map((o) => ({ value: o.id, label: o.name })),
                  ]}
                />
              </div>
            ) : null}
          </div>
        </Section>

        <Section title="When">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="calls-from">Started from</Label>
              <Input
                id="calls-from"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="calls-to">Started to</Label>
              <Input
                id="calls-to"
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="calls-min-dur">Min duration (s)</Label>
              <Input
                id="calls-min-dur"
                type="number"
                min="0"
                value={minDur}
                onChange={(e) => setMinDur(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="calls-max-dur">Max duration (s)</Label>
              <Input
                id="calls-max-dur"
                type="number"
                min="0"
                value={maxDur}
                onChange={(e) => setMaxDur(e.target.value)}
              />
            </div>
          </div>
        </Section>

        <div className="flex justify-between gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={clear}>
            Clear
          </Button>
          <Button size="sm" onClick={apply}>
            Apply filters
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <p className="text-muted-foreground text-[10px] font-semibold tracking-[0.16em] uppercase">
        {title}
      </p>
      {children}
    </section>
  );
}

function Pickable({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
