"use client";

import { useState } from "react";
import { Filter } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";

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

const STATUSES = [
  "ready_to_call",
  "callback",
  "resting",
  "goal_met",
  "attended",
  "no_show",
  "closed",
  "sale",
  "dnc",
  "email_replied",
];

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
];

const FILTER_KEYS = [
  "list",
  "status",
  "outcome",
  "created_from",
  "created_to",
  "lastcall_from",
  "lastcall_to",
  "nextcall_from",
  "nextcall_to",
];

function humanize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, " ");
}

export function LeadsFilters({
  lists,
}: {
  lists: { id: string; name: string }[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);

  const get = (key: string) => searchParams.get(key) ?? "";
  const [list, setList] = useState(get("list") || "any");
  const [status, setStatus] = useState(get("status") || "any");
  const [outcome, setOutcome] = useState(get("outcome") || "any");
  const [createdFrom, setCreatedFrom] = useState(get("created_from"));
  const [createdTo, setCreatedTo] = useState(get("created_to"));
  const [lastFrom, setLastFrom] = useState(get("lastcall_from"));
  const [lastTo, setLastTo] = useState(get("lastcall_to"));
  const [nextFrom, setNextFrom] = useState(get("nextcall_from"));
  const [nextTo, setNextTo] = useState(get("nextcall_to"));

  const activeCount = FILTER_KEYS.filter((key) => searchParams.get(key)).length;

  function apply() {
    const params = new URLSearchParams(searchParams.toString());
    const set = (key: string, value: string) => {
      if (value && value !== "any") params.set(key, value);
      else params.delete(key);
    };
    set("list", list);
    set("status", status);
    set("outcome", outcome);
    set("created_from", createdFrom);
    set("created_to", createdTo);
    set("lastcall_from", lastFrom);
    set("lastcall_to", lastTo);
    set("nextcall_from", nextFrom);
    set("nextcall_to", nextTo);
    params.delete("page");
    router.push(`/leads?${params.toString()}`);
    setOpen(false);
  }

  function clear() {
    const params = new URLSearchParams(searchParams.toString());
    for (const key of [...FILTER_KEYS, "page"]) params.delete(key);
    setList("any");
    setStatus("any");
    setOutcome("any");
    setCreatedFrom("");
    setCreatedTo("");
    setLastFrom("");
    setLastTo("");
    setNextFrom("");
    setNextTo("");
    router.push(`/leads?${params.toString()}`);
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
      <PopoverContent align="start" className="w-80">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="filter-list">List</Label>
            <Select value={list} onValueChange={setList}>
              <SelectTrigger id="filter-list">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any list</SelectItem>
                {lists.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="filter-status">Status</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger id="filter-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any status</SelectItem>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {humanize(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="filter-outcome">Last outcome</Label>
            <Select value={outcome} onValueChange={setOutcome}>
              <SelectTrigger id="filter-outcome">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any outcome</SelectItem>
                {OUTCOMES.map((o) => (
                  <SelectItem key={o} value={o}>
                    {humanize(o)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DateRange
            label="Created"
            from={createdFrom}
            to={createdTo}
            onFrom={setCreatedFrom}
            onTo={setCreatedTo}
          />
          <DateRange
            label="Last call"
            from={lastFrom}
            to={lastTo}
            onFrom={setLastFrom}
            onTo={setLastTo}
          />
          <DateRange
            label="Next call"
            from={nextFrom}
            to={nextTo}
            onFrom={setNextFrom}
            onTo={setNextTo}
          />
          <div className="flex justify-between gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={clear}>
              Clear
            </Button>
            <Button size="sm" onClick={apply}>
              Apply filters
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function DateRange({
  label,
  from,
  to,
  onFrom,
  onTo,
}: {
  label: string;
  from: string;
  to: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          type="date"
          aria-label={`${label} from`}
          value={from}
          onChange={(e) => onFrom(e.target.value)}
        />
        <span className="text-muted-foreground text-sm">to</span>
        <Input
          type="date"
          aria-label={`${label} to`}
          value={to}
          onChange={(e) => onTo(e.target.value)}
        />
      </div>
    </div>
  );
}
