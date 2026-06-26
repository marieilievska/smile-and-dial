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

/** Reporting scope selector. Picks All campaigns or one campaign and navigates
 *  to the same page with the new `?scope=` value (preserving the current
 *  tab/day). `value` is the serialized scope ("all" or "campaign:<id>"). */
export function ScopePicker({
  campaigns,
  value,
}: {
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
        <SelectValue placeholder="All campaigns (combined)" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All campaigns (combined)</SelectItem>
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
