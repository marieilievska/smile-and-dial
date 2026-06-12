"use client";

import { createContext, useContext, useState } from "react";

import { Checkbox } from "@/components/ui/checkbox";

type SelectionValue = {
  selected: Set<string>;
  allIds: string[];
  /** When true, the user clicked "Select all N matching" — the selection spans
   *  every match across pages, not just the visible page. The set in `selected`
   *  is the materialized (capped) list of those ids. */
  matchAll: boolean;
  toggle: (id: string) => void;
  toggleAll: () => void;
  setMatchAllSelection: (ids: string[]) => void;
  clear: () => void;
};

const CallsSelectionContext = createContext<SelectionValue | null>(null);

/**
 * Tracks which calls are checked on the current Calls view (admin-only, for
 * bulk delete). The selection resets whenever the visible rows change — a new
 * page, filter, or sort — so a delete never touches a row the user can no
 * longer see.
 */
export function CallsSelectionProvider({
  allIds,
  children,
}: {
  allIds: string[];
  children: React.ReactNode;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [matchAll, setMatchAll] = useState(false);

  // Reset selection when the visible calls change.
  const allKey = allIds.join(",");
  const [seenKey, setSeenKey] = useState(allKey);
  if (seenKey !== allKey) {
    setSeenKey(allKey);
    setSelected(new Set());
    setMatchAll(false);
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    // Hand-picking a row escapes match-all mode — the user is no longer
    // sweeping the whole result set.
    if (matchAll) setMatchAll(false);
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size === allIds.length ? new Set() : new Set(allIds),
    );
    setMatchAll(false);
  }

  function setMatchAllSelection(ids: string[]) {
    setSelected(new Set(ids));
    setMatchAll(true);
  }

  function clear() {
    setSelected(new Set());
    setMatchAll(false);
  }

  return (
    <CallsSelectionContext.Provider
      value={{
        selected,
        allIds,
        matchAll,
        toggle,
        toggleAll,
        setMatchAllSelection,
        clear,
      }}
    >
      {children}
    </CallsSelectionContext.Provider>
  );
}

export function useCallsSelection(): SelectionValue {
  const ctx = useContext(CallsSelectionContext);
  if (!ctx) {
    throw new Error(
      "useCallsSelection must be used within a CallsSelectionProvider.",
    );
  }
  return ctx;
}

/** Header checkbox that selects or clears every call on the page. */
export function CallSelectAllCheckbox() {
  const { selected, allIds, toggleAll } = useCallsSelection();
  const allChecked =
    allIds.length > 0 && allIds.every((id) => selected.has(id));
  return (
    <Checkbox
      checked={allChecked}
      onCheckedChange={toggleAll}
      aria-label="Select all calls"
    />
  );
}

/** Per-row checkbox. Stops propagation so checking it doesn't open the call
 *  detail modal (the row is click-to-open). */
export function CallRowCheckbox({ callId }: { callId: string }) {
  const { selected, toggle } = useCallsSelection();
  return (
    <span
      className="flex"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <Checkbox
        checked={selected.has(callId)}
        onCheckedChange={() => toggle(callId)}
        aria-label="Select call"
      />
    </span>
  );
}
