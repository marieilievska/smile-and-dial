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

import { humanizeKind } from "./humanize-kind";

/** Filter popover for /system-health. Round 22 — replaces the inline
 *  filter wall. Severity lives in its own pill row (primary axis);
 *  Kind + From + To collapse here. Apply pushes, Clear nukes.
 *
 *  Active-count badge bumps when Kind or any date is set. */
const FILTER_KEYS = ["kind", "from", "to"] as const;

export function SystemHealthFilters({ knownKinds }: { knownKinds: string[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);

  const get = (key: string) => searchParams.get(key) ?? "";
  const [kind, setKind] = useState(get("kind") || "any");
  const [from, setFrom] = useState(get("from"));
  const [to, setTo] = useState(get("to"));

  const activeCount = FILTER_KEYS.filter((key) => {
    const v = searchParams.get(key);
    if (key === "kind") return v && v !== "any";
    return Boolean(v);
  }).length;

  function apply() {
    const params = new URLSearchParams(searchParams.toString());
    const set = (key: string, value: string) => {
      if (value && value !== "any") params.set(key, value);
      else params.delete(key);
    };
    set("kind", kind);
    set("from", from);
    set("to", to);
    router.push(`/system-health?${params.toString()}`);
    setOpen(false);
  }

  function clear() {
    const params = new URLSearchParams(searchParams.toString());
    for (const key of FILTER_KEYS) params.delete(key);
    setKind("any");
    setFrom("");
    setTo("");
    router.push(`/system-health?${params.toString()}`);
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
        <Section title="Kind">
          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger id="sh-filter-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any kind</SelectItem>
              {knownKinds.map((k) => (
                <SelectItem key={k} value={k}>
                  {humanizeKind(k)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Section>

        <Section title="When">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sh-filter-from">From</Label>
              <Input
                id="sh-filter-from"
                type="date"
                value={from}
                max={to || undefined}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sh-filter-to">To</Label>
              <Input
                id="sh-filter-to"
                type="date"
                value={to}
                min={from || undefined}
                onChange={(e) => setTo(e.target.value)}
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
