"use client";

import { Eye, X } from "lucide-react";
import { useEffect, useState } from "react";

/** "Since you last looked" chip rendered above the activity feed.
 *  Compares each feed item's timestamp to the local-stored
 *  `lead-<id>-last-viewed` value (per-device, per-browser), counts how
 *  many items are new, and shows a one-line chip with the count + the
 *  most recent item's description.
 *
 *  Why localStorage and not a DB column? An internal tool with one
 *  user per device doesn't need cross-device sync, and skipping the
 *  migration keeps this PR zero-schema. */
export function SinceLastViewed({
  leadId,
  items,
}: {
  leadId: string;
  items: { at: string; description: string }[];
}) {
  // null = haven't checked localStorage yet (SSR safety)
  // string = previous last-viewed ISO
  // false = no previous record OR dismissed
  const [previousAt, setPreviousAt] = useState<string | null | false>(null);

  // On mount: read the previously-stored timestamp from localStorage,
  // then write "now" so the next visit knows what's been seen. This
  // setState-in-effect is the canonical pattern for syncing client-
  // only browser state on hydration — server can't read localStorage,
  // so the initial render is null and the effect catches up.
  useEffect(() => {
    const key = `lead-${leadId}-last-viewed`;
    const previous = window.localStorage.getItem(key);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPreviousAt(previous ?? false);
    window.localStorage.setItem(key, new Date().toISOString());
  }, [leadId]);

  // SSR / first paint / never-visited / dismissed → render nothing.
  if (previousAt === null || previousAt === false) return null;

  const newItems = items.filter((item) => item.at > previousAt);
  if (newItems.length === 0) return null;

  const headline = newItems[0].description;
  const tail = newItems.length > 1 ? ` · ${newItems.length - 1} more` : "";

  return (
    <div
      data-testid="since-last-viewed"
      className="bg-card flex items-start justify-between gap-3 rounded-lg border px-3 py-2"
      style={{
        borderColor: "color-mix(in oklab, var(--primary) 35%, transparent)",
        backgroundColor: "color-mix(in oklab, var(--primary) 6%, var(--card))",
      }}
    >
      <div className="flex items-start gap-2">
        <Eye
          className="mt-0.5 size-4 shrink-0"
          style={{ color: "var(--primary)" }}
        />
        <div className="flex flex-col gap-0.5">
          <p className="text-foreground text-xs font-medium">
            {newItems.length} new since you last looked
          </p>
          <p className="text-muted-foreground text-xs">
            {headline}
            {tail}
          </p>
        </div>
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setPreviousAt(false)}
        className="text-muted-foreground hover:text-foreground -mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md transition-colors"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
