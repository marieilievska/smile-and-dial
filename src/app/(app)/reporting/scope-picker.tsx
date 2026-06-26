"use client";

import { useRouter, useSearchParams } from "next/navigation";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Option = { id: string; name: string };

/** Reporting scope selector. Picks All agents, one agent, or one campaign and
 *  navigates to the same page with the new `?scope=` value (preserving the
 *  current tab/day). `value` is the serialized scope (e.g. "all",
 *  "agent:<id>"). */
export function ScopePicker({
  agents,
  campaigns,
  value,
}: {
  agents: Option[];
  campaigns: Option[];
  value: string;
}) {
  const router = useRouter();
  const sp = useSearchParams();

  function onChange(next: string) {
    const params = new URLSearchParams(sp.toString());
    params.set("scope", next);
    router.push(`/reporting?${params.toString()}`);
  }

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id="reporting-scope" className="w-[260px]">
        <SelectValue placeholder="All agents (combined)" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All agents (combined)</SelectItem>
        {agents.length > 0 ? (
          <SelectGroup>
            <SelectLabel>Agents</SelectLabel>
            {agents.map((a) => (
              <SelectItem key={a.id} value={`agent:${a.id}`}>
                {a.name}
              </SelectItem>
            ))}
          </SelectGroup>
        ) : null}
        {campaigns.length > 0 ? (
          <SelectGroup>
            <SelectLabel>Campaigns</SelectLabel>
            {campaigns.map((c) => (
              <SelectItem key={c.id} value={`campaign:${c.id}`}>
                {c.name}
              </SelectItem>
            ))}
          </SelectGroup>
        ) : null}
      </SelectContent>
    </Select>
  );
}
