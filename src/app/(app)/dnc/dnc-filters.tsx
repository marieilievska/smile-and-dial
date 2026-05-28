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

/** Filter popover for /dnc. Replaces the inline filter wall that
 *  previously sat below the header. Three axes (Reason / Added from /
 *  Added to) — Apply pushes a new URL and closes; Clear nukes all
 *  three plus pagination. Matches the calls/callbacks pattern. */
const REASON_OPTIONS = [
  { value: "dnc_requested", label: "Caller requested" },
  { value: "invalid_number", label: "Invalid number" },
  { value: "language_barrier", label: "Language barrier" },
  { value: "manual", label: "Manual" },
  { value: "imported", label: "Imported" },
];

const FILTER_KEYS = ["reason", "from", "to"] as const;

export function DncFilters() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);

  const get = (key: string) => searchParams.get(key) ?? "";
  const [reason, setReason] = useState(get("reason") || "any");
  const [from, setFrom] = useState(get("from"));
  const [to, setTo] = useState(get("to"));

  const activeCount = FILTER_KEYS.filter((key) => {
    const v = searchParams.get(key);
    if (key === "reason") return v && v !== "any";
    return Boolean(v);
  }).length;

  function apply() {
    const params = new URLSearchParams(searchParams.toString());
    const set = (key: string, value: string) => {
      if (value && value !== "any") params.set(key, value);
      else params.delete(key);
    };
    set("reason", reason);
    set("from", from);
    set("to", to);
    params.delete("page");
    router.push(`/dnc?${params.toString()}`);
    setOpen(false);
  }

  function clear() {
    const params = new URLSearchParams(searchParams.toString());
    for (const key of FILTER_KEYS) params.delete(key);
    params.delete("page");
    setReason("any");
    setFrom("");
    setTo("");
    router.push(`/dnc?${params.toString()}`);
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
        className="flex w-[min(420px,92vw)] flex-col gap-5"
      >
        <Section title="Reason">
          <Select value={reason} onValueChange={setReason}>
            <SelectTrigger id="dnc-filter-reason">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any reason</SelectItem>
              {REASON_OPTIONS.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Section>

        <Section title="Added">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dnc-filter-from">From</Label>
              <Input
                id="dnc-filter-from"
                type="date"
                value={from}
                max={to || undefined}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dnc-filter-to">To</Label>
              <Input
                id="dnc-filter-to"
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
