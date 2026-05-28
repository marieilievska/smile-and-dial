"use client";

import { Filter } from "lucide-react";
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

type Option = { id: string; name: string };

/** Filter popover for /costs. Holds Campaign + List + User. Date
 *  range lives in its own pill row above the page (primary axis).
 *  Mirrors the analytics filters pattern. */
const FILTER_KEYS = ["campaign", "list", "user"] as const;

export function CostsFilters({
  campaigns,
  lists,
  owners,
  showOwner,
}: {
  campaigns: Option[];
  lists: Option[];
  owners: Option[];
  showOwner: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);

  const get = (key: string) => searchParams.get(key) ?? "";
  const [campaign, setCampaign] = useState(get("campaign") || "any");
  const [list, setList] = useState(get("list") || "any");
  const [user, setUser] = useState(get("user") || "any");

  const activeCount = FILTER_KEYS.filter((key) => {
    const v = searchParams.get(key);
    return v && v !== "any";
  }).length;

  function apply() {
    const params = new URLSearchParams(searchParams.toString());
    const set = (key: string, value: string) => {
      if (value && value !== "any") params.set(key, value);
      else params.delete(key);
    };
    set("campaign", campaign);
    set("list", list);
    set("user", user);
    router.push(`/costs?${params.toString()}`);
    setOpen(false);
  }

  function clear() {
    const params = new URLSearchParams(searchParams.toString());
    for (const key of FILTER_KEYS) params.delete(key);
    setCampaign("any");
    setList("any");
    setUser("any");
    router.push(`/costs?${params.toString()}`);
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
