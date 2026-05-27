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

/** Filter keys that count toward the "active filters" badge on the
 *  popover trigger. Status lives in the tabs, not here, so it's not
 *  counted. `range` is from stat-strip shortcuts (today/week/overdue)
 *  and isn't user-editable here. */
const FILTER_KEYS = ["campaign", "from", "to", "voicemail"] as const;

/** URL-driven filter popover for the Callbacks table. Single section
 *  since there's only a handful of filterable axes (campaign, date
 *  range, voicemail count). */
export function CallbacksFilters({ campaigns }: { campaigns: Campaign[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);

  const get = (key: string) => searchParams.get(key) ?? "";
  const [campaign, setCampaign] = useState(get("campaign") || "any");
  const [from, setFrom] = useState(get("from"));
  const [to, setTo] = useState(get("to"));
  const [voicemail, setVoicemail] = useState(get("voicemail") || "any");

  const activeCount = FILTER_KEYS.filter((key) =>
    searchParams.get(key as string),
  ).length;

  function apply() {
    const params = new URLSearchParams(searchParams.toString());
    const set = (key: string, value: string) => {
      if (value && value !== "any") params.set(key, value);
      else params.delete(key);
    };
    set("campaign", campaign);
    set("from", from);
    set("to", to);
    set("voicemail", voicemail);
    params.delete("page");
    // Clear the stat-strip shortcut range too — it conflicts with an
    // explicit from/to window.
    if (from || to) params.delete("range");
    router.push(`/callbacks?${params.toString()}`);
    setOpen(false);
  }

  function clear() {
    const params = new URLSearchParams(searchParams.toString());
    for (const key of FILTER_KEYS) params.delete(key as string);
    params.delete("page");
    params.delete("range");
    setCampaign("any");
    setFrom("");
    setTo("");
    setVoicemail("any");
    router.push(`/callbacks?${params.toString()}`);
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
        className="flex w-[min(480px,92vw)] flex-col gap-5"
      >
        <Section title="Where">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cb-campaign">Campaign</Label>
            <Select value={campaign} onValueChange={setCampaign}>
              <SelectTrigger id="cb-campaign">
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
        </Section>

        <Section title="Scheduled">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cb-from">From</Label>
              <Input
                id="cb-from"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cb-to">To</Label>
              <Input
                id="cb-to"
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
          </div>
        </Section>

        <Section title="Voicemail history">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cb-voicemail">Attempts</Label>
            <Select value={voicemail} onValueChange={setVoicemail}>
              <SelectTrigger id="cb-voicemail">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any</SelectItem>
                <SelectItem value="none">None (0)</SelectItem>
                <SelectItem value="some">At least one (≥1)</SelectItem>
                <SelectItem value="repeat">Repeat (≥2)</SelectItem>
              </SelectContent>
            </Select>
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
