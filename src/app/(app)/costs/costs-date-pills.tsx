"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Date-range segmented control at the top of /costs. Sibling of the
 *  analytics date pills — same visual treatment (pill row with
 *  bg-foreground active state, expanding inline From/To when Custom
 *  is selected). */
const PRESETS: { value: string; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "last7", label: "7 days" },
  { value: "last30", label: "30 days" },
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "custom", label: "Custom" },
];

export function CostsDatePills({
  current,
  initialFrom,
  initialTo,
}: {
  current: string;
  initialFrom?: string;
  initialTo?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [from, setFrom] = useState(initialFrom ?? "");
  const [to, setTo] = useState(initialTo ?? "");

  function hrefFor(value: string): string {
    const params = new URLSearchParams(searchParams.toString());
    params.set("preset", value);
    if (value !== "custom") {
      params.delete("from");
      params.delete("to");
    }
    return `/costs?${params.toString()}`;
  }

  function applyCustom() {
    const params = new URLSearchParams(searchParams.toString());
    params.set("preset", "custom");
    if (from) params.set("from", from);
    else params.delete("from");
    if (to) params.set("to", to);
    else params.delete("to");
    router.push(`/costs?${params.toString()}`);
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div
        role="tablist"
        aria-label="Date range"
        className="border-border bg-background inline-flex flex-wrap items-center gap-0.5 rounded-xl border p-1"
      >
        {PRESETS.map((p) => {
          const active = current === p.value;
          return (
            <Link
              key={p.value}
              href={hrefFor(p.value)}
              role="tab"
              aria-selected={active}
              className={`inline-flex h-8 items-center rounded-md px-3 text-sm font-medium transition-colors ${
                active
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
              }`}
            >
              {p.label}
            </Link>
          );
        })}
      </div>

      {current === "custom" ? (
        <div
          data-testid="costs-custom-date-inputs"
          className="border-border bg-background animate-in fade-in slide-in-from-left-1 fill-mode-both flex flex-wrap items-end gap-2 rounded-xl border p-2 duration-300"
        >
          <div className="flex flex-col gap-1">
            <Label
              htmlFor="costs-date-from"
              className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase"
            >
              From
            </Label>
            <Input
              id="costs-date-from"
              type="date"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
              className="h-8 w-[10.5rem]"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label
              htmlFor="costs-date-to"
              className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase"
            >
              To
            </Label>
            <Input
              id="costs-date-to"
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
              className="h-8 w-[10.5rem]"
            />
          </div>
          <Button
            size="sm"
            onClick={applyCustom}
            disabled={!from || !to}
            className="h-8"
          >
            Apply
          </Button>
        </div>
      ) : null}
    </div>
  );
}
