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
import { leadStatusLabel } from "@/lib/labels";

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

const FILTER_KEYS = [
  "list",
  "status",
  "created_from",
  "created_to",
  "lastcall_from",
  "lastcall_to",
  "nextcall_from",
  "nextcall_to",
];

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
  const [createdFrom, setCreatedFrom] = useState(get("created_from"));
  const [createdTo, setCreatedTo] = useState(get("created_to"));
  const [lastFrom, setLastFrom] = useState(get("lastcall_from"));
  const [lastTo, setLastTo] = useState(get("lastcall_to"));
  const [nextFrom, setNextFrom] = useState(get("nextcall_from"));
  const [nextTo, setNextTo] = useState(get("nextcall_to"));

  // Resync the draft fields whenever the URL filters change from OUTSIDE the
  // popover — removing an active-filter chip, a stat-strip tile, a saved
  // view. Without this the draft only seeds once (the useState initializers
  // above) and Apply would silently re-add filters the user just removed.
  // This is the "derived state with a reset trigger" pattern from
  // search-input.tsx: track the last params string we synced from and reset
  // the draft when it changes, rather than putting a setState in an effect.
  const paramsKey = searchParams.toString();
  const [lastParamsKey, setLastParamsKey] = useState(paramsKey);
  if (paramsKey !== lastParamsKey) {
    setLastParamsKey(paramsKey);
    setList(get("list") || "any");
    setStatus(get("status") || "any");
    setCreatedFrom(get("created_from"));
    setCreatedTo(get("created_to"));
    setLastFrom(get("lastcall_from"));
    setLastTo(get("lastcall_to"));
    setNextFrom(get("nextcall_from"));
    setNextTo(get("nextcall_to"));
  }

  const activeCount = FILTER_KEYS.filter((key) => searchParams.get(key)).length;

  function apply() {
    const params = new URLSearchParams(searchParams.toString());
    const set = (key: string, value: string) => {
      if (value && value !== "any") params.set(key, value);
      else params.delete(key);
    };
    set("list", list);
    set("status", status);
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
            <Label htmlFor="filter-status">Stage</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger id="filter-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any stage</SelectItem>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {leadStatusLabel(s)}
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
