"use client";

import { Filter, LayoutGrid, Rows3 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

import { GOAL_STATUS_LABELS } from "./status-variant";

type GoalDef = { id: string; name: string };
type CampaignDef = { id: string; name: string };

/** Toolbar above the pipeline list: status tabs (left), view toggle
 *  (Table | Board) and Filters popover (right). All URL-driven so
 *  refresh / back / share preserve state. */
export function PipelineToolbar({
  goals,
  campaigns,
  currentStatus,
  currentView,
  counts,
}: {
  goals: GoalDef[];
  campaigns: CampaignDef[];
  currentStatus: string;
  currentView: "table" | "board";
  counts: Record<string, number>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <StatusTabs current={currentStatus} counts={counts} />
      <div className="flex-1" />
      <ViewToggle current={currentView} />
      <PipelineFilters goals={goals} campaigns={campaigns} />
    </div>
  );
}

const STATUS_TABS: { value: string; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "goal_met", label: GOAL_STATUS_LABELS.goal_met },
  { value: "attended", label: GOAL_STATUS_LABELS.attended },
  { value: "no_show", label: GOAL_STATUS_LABELS.no_show },
  { value: "sale", label: GOAL_STATUS_LABELS.sale },
  { value: "closed", label: GOAL_STATUS_LABELS.closed },
  { value: "all", label: "All" },
];

function StatusTabs({
  current,
  counts,
}: {
  current: string;
  counts: Record<string, number>;
}) {
  const searchParams = useSearchParams();
  function hrefFor(value: string): string {
    const params = new URLSearchParams(searchParams.toString());
    params.set("status", value);
    return `/goals?${params.toString()}`;
  }

  return (
    <div
      role="tablist"
      aria-label="Pipeline status"
      className="border-border bg-background inline-flex items-center gap-0.5 rounded-xl border p-1"
    >
      {STATUS_TABS.map((tab) => {
        const active = current === tab.value;
        const count = counts[tab.value];
        return (
          <Link
            key={tab.value}
            href={hrefFor(tab.value)}
            role="tab"
            aria-selected={active}
            className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors ${
              active
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
            }`}
          >
            {tab.label}
            {typeof count === "number" && count > 0 ? (
              <span
                className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] tabular-nums ${
                  active
                    ? "bg-background/15 text-background"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {count}
              </span>
            ) : null}
          </Link>
        );
      })}
    </div>
  );
}

function ViewToggle({ current }: { current: "table" | "board" }) {
  const searchParams = useSearchParams();
  // Board is the default — only the table view needs an explicit
  // ?view=table param, so toggling back to board drops it.
  function hrefFor(view: "table" | "board"): string {
    const params = new URLSearchParams(searchParams.toString());
    if (view === "board") params.delete("view");
    else params.set("view", view);
    return `/goals?${params.toString()}`;
  }
  return (
    <div
      role="tablist"
      aria-label="Pipeline view"
      className="border-border bg-background inline-flex items-center gap-0.5 rounded-xl border p-1"
    >
      <ViewLink
        href={hrefFor("board")}
        active={current === "board"}
        label="Board"
        icon={<LayoutGrid className="size-4" />}
      />
      <ViewLink
        href={hrefFor("table")}
        active={current === "table"}
        label="Table"
        icon={<Rows3 className="size-4" />}
      />
    </div>
  );
}

function ViewLink({
  href,
  active,
  label,
  icon,
}: {
  href: string;
  active: boolean;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      role="tab"
      aria-selected={active}
      aria-label={label}
      title={label}
      className={`inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors ${
        active
          ? "bg-foreground text-background"
          : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
      }`}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </Link>
  );
}

const FILTER_KEYS = ["goal", "campaign"] as const;

function PipelineFilters({
  goals,
  campaigns,
}: {
  goals: GoalDef[];
  campaigns: CampaignDef[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);

  const get = (key: string) => searchParams.get(key) ?? "";
  const [goal, setGoal] = useState(get("goal") || "any");
  const [campaign, setCampaign] = useState(get("campaign") || "any");

  const activeCount = FILTER_KEYS.filter((key) =>
    searchParams.get(key as string),
  ).length;

  function apply() {
    const params = new URLSearchParams(searchParams.toString());
    const set = (key: string, value: string) => {
      if (value && value !== "any") params.set(key, value);
      else params.delete(key);
    };
    set("goal", goal);
    set("campaign", campaign);
    router.push(`/goals?${params.toString()}`);
    setOpen(false);
  }

  function clear() {
    const params = new URLSearchParams(searchParams.toString());
    for (const key of FILTER_KEYS) params.delete(key as string);
    setGoal("any");
    setCampaign("any");
    router.push(`/goals?${params.toString()}`);
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
        align="end"
        className="flex w-[min(420px,92vw)] flex-col gap-4"
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="goal-filter">Goal</Label>
          <Select value={goal} onValueChange={setGoal}>
            <SelectTrigger id="goal-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any goal</SelectItem>
              {goals.map((g) => (
                <SelectItem key={g.id} value={g.id}>
                  {g.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="campaign-filter">Campaign</Label>
          <Select value={campaign} onValueChange={setCampaign}>
            <SelectTrigger id="campaign-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any campaign</SelectItem>
              {campaigns.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
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
