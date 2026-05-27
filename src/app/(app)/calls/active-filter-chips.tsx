"use client";

import { X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";

type LookupOption = { id: string; name: string };

/** Inline chips for each active filter on /calls. Click the × on a
 *  chip to remove just that filter (route.push). Renders nothing when
 *  no filters are active. Mirrors the leads version. */
export function CallsActiveFilterChips({
  campaigns,
  agents,
  owners,
}: {
  campaigns: LookupOption[];
  agents: LookupOption[];
  owners: LookupOption[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const campaignMap = new Map(campaigns.map((c) => [c.id, c.name]));
  const agentMap = new Map(agents.map((a) => [a.id, a.name]));
  const ownerMap = new Map(owners.map((o) => [o.id, o.name]));

  const chips: { key: string; label: string }[] = [];

  const direction = searchParams.get("direction");
  if (direction) {
    chips.push({
      key: "direction",
      label: `Direction: ${humanize(direction)}`,
    });
  }
  const status = searchParams.get("status");
  if (status)
    chips.push({ key: "status", label: `Status: ${humanize(status)}` });
  const outcome = searchParams.get("outcome");
  if (outcome) {
    chips.push({ key: "outcome", label: `Outcome: ${humanize(outcome)}` });
  }
  const goalMet = searchParams.get("goal_met");
  if (goalMet) {
    chips.push({
      key: "goal_met",
      label: `Goal met: ${goalMet === "yes" ? "Yes" : "No"}`,
    });
  }
  const campaign = searchParams.get("campaign");
  if (campaign) {
    chips.push({
      key: "campaign",
      label: `Campaign: ${campaignMap.get(campaign) ?? "Unknown"}`,
    });
  }
  const agent = searchParams.get("agent");
  if (agent) {
    chips.push({
      key: "agent",
      label: `Agent: ${agentMap.get(agent) ?? "Unknown"}`,
    });
  }
  const owner = searchParams.get("owner");
  if (owner) {
    chips.push({
      key: "owner",
      label: `Owner: ${ownerMap.get(owner) ?? "Unknown"}`,
    });
  }
  const minDur = searchParams.get("min_dur");
  if (minDur) chips.push({ key: "min_dur", label: `Min duration: ${minDur}s` });
  const maxDur = searchParams.get("max_dur");
  if (maxDur) chips.push({ key: "max_dur", label: `Max duration: ${maxDur}s` });
  const fromDate = searchParams.get("from");
  const toDate = searchParams.get("to");
  if (fromDate || toDate) {
    chips.push({
      key: "__range:from:to",
      label: `Started: ${[fromDate, toDate].filter(Boolean).join(" → ") || "any"}`,
    });
  }

  if (chips.length === 0) return null;

  function remove(key: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (key.startsWith("__range:")) {
      const [, fromKey, toKey] = key.split(":");
      params.delete(fromKey);
      params.delete(toKey);
    } else {
      params.delete(key);
    }
    params.delete("page");
    const qs = params.toString();
    router.push(qs ? `/calls?${qs}` : "/calls");
  }

  function clearAll() {
    const params = new URLSearchParams(searchParams.toString());
    for (const key of [
      "direction",
      "status",
      "outcome",
      "goal_met",
      "campaign",
      "agent",
      "owner",
      "min_dur",
      "max_dur",
      "from",
      "to",
      "page",
    ]) {
      params.delete(key);
    }
    const qs = params.toString();
    router.push(qs ? `/calls?${qs}` : "/calls");
  }

  return (
    <div
      data-testid="calls-active-filter-chips"
      className="flex flex-wrap items-center gap-1.5"
    >
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          onClick={() => remove(chip.key)}
          className="border-border bg-muted/40 hover:bg-muted text-foreground inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition-colors"
        >
          {chip.label}
          <X className="text-muted-foreground size-3" />
        </button>
      ))}
      {chips.length > 1 ? (
        <button
          type="button"
          onClick={clearAll}
          className="text-muted-foreground hover:text-foreground px-1 text-xs underline-offset-2 hover:underline"
        >
          Clear all
        </button>
      ) : null}
    </div>
  );
}

function humanize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, " ");
}
