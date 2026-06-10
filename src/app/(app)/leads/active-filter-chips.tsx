"use client";

import { X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";

import { leadStatusLabel } from "@/lib/labels";

/** Inline chips for each active filter on /leads. Click the × on a chip
 *  to remove just that filter (route.replace, no history pollution).
 *  Renders nothing when no filters are active. */
export function ActiveFilterChips({
  lists,
}: {
  lists: { id: string; name: string }[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const listMap = new Map(lists.map((l) => [l.id, l.name]));

  const chips: { key: string; label: string }[] = [];

  const status = searchParams.get("status");
  if (status)
    chips.push({ key: "status", label: `Stage: ${leadStatusLabel(status)}` });

  const list = searchParams.get("list");
  if (list)
    chips.push({
      key: "list",
      label: `List: ${listMap.get(list) ?? "Unknown"}`,
    });

  const pairs: [string, string, string][] = [
    ["created_from", "created_to", "Created"],
    ["lastcall_from", "lastcall_to", "Last call"],
    ["nextcall_from", "nextcall_to", "Next call"],
  ];
  for (const [fromKey, toKey, label] of pairs) {
    const from = searchParams.get(fromKey);
    const to = searchParams.get(toKey);
    if (from || to) {
      const value = [from, to].filter(Boolean).join(" → ") || "any";
      chips.push({
        key: `__range:${fromKey}:${toKey}`,
        label: `${label}: ${value}`,
      });
    }
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
    router.replace(qs ? `/leads?${qs}` : "/leads");
  }

  function clearAll() {
    const params = new URLSearchParams(searchParams.toString());
    for (const key of [
      "status",
      "list",
      "created_from",
      "created_to",
      "lastcall_from",
      "lastcall_to",
      "nextcall_from",
      "nextcall_to",
      "page",
    ]) {
      params.delete(key);
    }
    const qs = params.toString();
    router.replace(qs ? `/leads?${qs}` : "/leads");
  }

  return (
    <div
      data-testid="active-filter-chips"
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
