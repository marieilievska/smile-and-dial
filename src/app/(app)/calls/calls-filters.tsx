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

type Campaign = { id: string; name: string };
type Agent = { id: string; name: string };
type Owner = { id: string; name: string };

const STATUSES = [
  "queued",
  "dialing",
  "ringing",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
] as const;

const OUTCOMES = [
  "voicemail",
  "no_answer",
  "busy",
  "failed",
  "hung_up_immediately",
  "invalid_number",
  "gatekeeper",
  "not_interested",
  "callback",
  "dnc",
  "goal_met",
  "language_barrier",
  "ai_receptionist",
  "ai_error",
  "transferred_to_human",
] as const;

/** Filter keys that count toward the "active filters" badge on the
 *  popover trigger. Search (`q`) is in the toolbar input, not the
 *  popover, so it's not counted here. */
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

function humanize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, " ");
}

/** URL-driven filter popover for the Calls table. Replaces the v1
 *  always-open filter wall — the 11 controls all live behind a single
 *  `Filters` button now. Search stays on the toolbar.
 *
 *  Picking "Any" clears the param. Apply pushes everything to the URL
 *  at once so the server re-renders with the new params. */
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
      <PopoverContent align="start" className="w-[min(560px,90vw)]">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
            label="Status"
            value={status}
            onChange={setStatus}
            options={[
              { value: "any", label: "Any" },
              ...STATUSES.map((s) => ({ value: s, label: humanize(s) })),
            ]}
          />
          <Pickable
            label="Outcome"
            value={outcome}
            onChange={setOutcome}
            options={[
              { value: "any", label: "Any" },
              ...OUTCOMES.map((o) => ({ value: o, label: humanize(o) })),
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
            <Pickable
              label="Owner"
              value={owner}
              onChange={setOwner}
              options={[
                { value: "any", label: "Any owner" },
                ...owners.map((o) => ({ value: o.id, label: o.name })),
              ]}
            />
          ) : null}

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
        </div>

        <div className="flex justify-between gap-2 pt-3">
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
