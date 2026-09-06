"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { etClock, exactDateTime } from "@/lib/relative-time";
import { deleteSmartList } from "@/lib/smart-lists/actions";

export type SmartListPickerItem = {
  id: string;
  name: string;
  filter: unknown;
  /** When smart_list_members was last rebuilt successfully (null = never). */
  last_refreshed_at: string | null;
  /** Message from the most recent failed refresh; null once it succeeds. */
  last_refresh_error: string | null;
};

/**
 * One-line freshness note for the active list. Absolute Eastern time rather
 * than "2m ago" so the server and client render the same string — this is a
 * client component that still server-renders, and a Date.now()-based label
 * would drift between the two and trip hydration.
 */
export function smartListFreshness(list: {
  last_refreshed_at: string | null;
  last_refresh_error: string | null;
}): { text: string; tone: "muted" | "error"; title: string } {
  if (list.last_refresh_error) {
    return {
      text: `Refresh failed: ${list.last_refresh_error}`,
      tone: "error",
      title: list.last_refreshed_at
        ? `Members are stale. Last good rebuild: ${exactDateTime(list.last_refreshed_at)}`
        : "Members are stale. This list has never rebuilt successfully.",
    };
  }
  if (list.last_refreshed_at) {
    return {
      text: `Updated ${etClock(list.last_refreshed_at)}`,
      tone: "muted",
      title: `Members last rebuilt ${exactDateTime(list.last_refreshed_at)}`,
    };
  }
  return {
    text: "Not refreshed yet",
    tone: "muted",
    title:
      "Members are rebuilt every 3 minutes while the list is attached to a campaign.",
  };
}

export function SmartListPicker({
  lists,
  activeRecipeJson,
}: {
  lists: SmartListPickerItem[];
  activeRecipeJson: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, start] = useTransition();

  const active = lists.find(
    (l) => JSON.stringify(l.filter) === activeRecipeJson,
  );
  const freshness = active ? smartListFreshness(active) : null;

  function load(id: string) {
    const l = lists.find((x) => x.id === id);
    if (!l) return;
    const sp = new URLSearchParams(searchParams.toString());
    sp.set("recipe", JSON.stringify(l.filter));
    sp.delete("page");
    router.push(`/leads?${sp.toString()}`);
  }

  function remove() {
    if (!active) return;
    start(async () => {
      const res = await deleteSmartList({ id: active.id });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success("Smart list deleted.");
    });
  }

  if (lists.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={active?.id ?? ""} onValueChange={load}>
        <SelectTrigger className="h-8 w-[15rem]">
          <SelectValue placeholder="Load a smart list…" />
        </SelectTrigger>
        <SelectContent>
          {lists.map((l) => (
            <SelectItem key={l.id} value={l.id}>
              {l.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {active ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={remove}
        >
          Delete
        </Button>
      ) : null}
      {freshness ? (
        <p
          className={`max-w-[24rem] truncate text-xs ${
            freshness.tone === "error"
              ? "text-destructive"
              : "text-muted-foreground"
          }`}
          title={freshness.title}
          role={freshness.tone === "error" ? "alert" : undefined}
        >
          {freshness.text}
        </p>
      ) : null}
    </div>
  );
}
