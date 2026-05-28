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

type Option = { id: string; name: string };

/** Filter popover for /analytics. Round 17 — replaces the inline
 *  filter wall. Date range lives in its own pill row above the page
 *  (it's the primary axis); Campaign / List / User / Compare /
 *  Custom date inputs collapse into this popover.
 *
 *  Custom From/To only render when the current preset is "custom" —
 *  the page passes `showCustomDates` accordingly. */
const FILTER_KEYS = ["campaign", "list", "user", "compare"] as const;

export function AnalyticsFilters({
  campaigns,
  lists,
  owners,
  showOwner,
  showCustomDates,
  initialFrom,
  initialTo,
}: {
  campaigns: Option[];
  lists: Option[];
  owners: Option[];
  showOwner: boolean;
  showCustomDates: boolean;
  initialFrom?: string;
  initialTo?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);

  const get = (key: string) => searchParams.get(key) ?? "";
  const [campaign, setCampaign] = useState(get("campaign") || "any");
  const [list, setList] = useState(get("list") || "any");
  const [user, setUser] = useState(get("user") || "any");
  const [compare, setCompare] = useState(get("compare") === "0" ? "0" : "1");
  const [from, setFrom] = useState(initialFrom ?? "");
  const [to, setTo] = useState(initialTo ?? "");

  // Active-filter badge count — any non-default value bumps the chip.
  const activeCount =
    FILTER_KEYS.filter((key) => {
      const v = searchParams.get(key);
      if (key === "compare") return v === "0"; // default is compare on
      return v && v !== "any";
    }).length + (showCustomDates && (initialFrom || initialTo) ? 1 : 0);

  function apply() {
    const params = new URLSearchParams(searchParams.toString());
    const set = (key: string, value: string, defaultValue?: string) => {
      if (value && value !== defaultValue) params.set(key, value);
      else params.delete(key);
    };
    set("campaign", campaign, "any");
    set("list", list, "any");
    set("user", user, "any");
    set("compare", compare, "1");
    if (showCustomDates) {
      if (from) params.set("from", from);
      else params.delete("from");
      if (to) params.set("to", to);
      else params.delete("to");
    }
    router.push(`/analytics?${params.toString()}`);
    setOpen(false);
  }

  function clear() {
    const params = new URLSearchParams(searchParams.toString());
    for (const key of FILTER_KEYS) params.delete(key);
    params.delete("from");
    params.delete("to");
    setCampaign("any");
    setList("any");
    setUser("any");
    setCompare("1");
    setFrom("");
    setTo("");
    router.push(`/analytics?${params.toString()}`);
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
        className="flex w-[min(460px,92vw)] flex-col gap-4"
      >
        {showCustomDates ? (
          <Section title="Custom dates">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ana-from">From</Label>
                <Input
                  id="ana-from"
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ana-to">To</Label>
                <Input
                  id="ana-to"
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </div>
            </div>
          </Section>
        ) : null}

        <Section title="Scope">
          <div className="flex flex-col gap-3">
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
              label="List"
              value={list}
              onChange={setList}
              options={[
                { value: "any", label: "Any list" },
                ...lists.map((l) => ({ value: l.id, label: l.name })),
              ]}
            />
            {showOwner ? (
              <Pickable
                label="User"
                value={user}
                onChange={setUser}
                options={[
                  { value: "any", label: "Any user" },
                  ...owners.map((o) => ({ value: o.id, label: o.name })),
                ]}
              />
            ) : null}
          </div>
        </Section>

        <Section title="Comparison">
          <Pickable
            label="Compare to"
            value={compare}
            onChange={setCompare}
            options={[
              { value: "1", label: "Prior period" },
              { value: "0", label: "No comparison" },
            ]}
          />
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
