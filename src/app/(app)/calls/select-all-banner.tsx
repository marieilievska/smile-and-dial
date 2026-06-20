"use client";

import { useTransition } from "react";
import { Loader2 } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";

import { fetchAllMatchingCallIds } from "./select-all-action";
import { useCallsSelection } from "./calls-selection";

/** Slim banner above the calls table that appears when (a) every call on the
 *  current page is selected, (b) the total result set is larger than the
 *  visible page, and (c) the user hasn't already escalated to "match all".
 *
 *  Clicking the link sweeps the server for every matching call id and selects
 *  them, so a bulk delete can clear the whole filtered set in one go. A second
 *  link backs out to page-only selection. Admin-only, like all calls selection. */
export function CallsSelectAllBanner({ total }: { total: number }) {
  const { selected, allIds, matchAll, setMatchAllSelection, toggleAll } =
    useCallsSelection();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const pageFullySelected =
    allIds.length > 0 && allIds.every((id) => selected.has(id));
  const moreOffPage = total > allIds.length;

  if (!pageFullySelected || !moreOffPage) return null;

  function selectAllMatching() {
    const params: Record<string, string> = {};
    for (const [key, value] of searchParams.entries()) {
      params[key] = value;
    }
    startTransition(async () => {
      const result = await fetchAllMatchingCallIds(params);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      setMatchAllSelection(result.ids);
      if (result.truncated) {
        toast.info(
          `Selected the first ${result.ids.length.toLocaleString()} matching calls — large sweeps are capped for safety.`,
        );
      } else {
        toast.success(
          `Selected all ${result.ids.length.toLocaleString()} matching calls.`,
        );
      }
    });
  }

  return (
    <div
      data-testid="calls-select-all-banner"
      className="bg-muted/30 border-border flex flex-wrap items-center gap-3 rounded-xl border px-3 py-2 text-sm"
    >
      {matchAll ? (
        <>
          <span className="text-foreground font-medium">
            All {selected.size.toLocaleString()} matching calls selected.
          </span>
          <button
            type="button"
            onClick={toggleAll}
            className="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
          >
            Back to selecting only this page
          </button>
        </>
      ) : (
        <>
          <span className="text-muted-foreground">
            All {allIds.length} on this page are selected.
          </span>
          <button
            type="button"
            onClick={selectAllMatching}
            disabled={pending}
            className="text-foreground inline-flex items-center gap-1.5 font-medium underline-offset-2 hover:underline disabled:opacity-60"
          >
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Select all {total.toLocaleString()} matching →
          </button>
        </>
      )}
    </div>
  );
}
