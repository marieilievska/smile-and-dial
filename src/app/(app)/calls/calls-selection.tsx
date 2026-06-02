"use client";

import { createContext, useContext, useState } from "react";

import { Checkbox } from "@/components/ui/checkbox";

type SelectionValue = {
  selected: Set<string>;
  allIds: string[];
  toggle: (id: string) => void;
  toggleAll: () => void;
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

  // Reset selection when the visible calls change.
  const allKey = allIds.join(",");
  const [seenKey, setSeenKey] = useState(allKey);
  if (seenKey !== allKey) {
    setSeenKey(allKey);
    setSelected(new Set());
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size === allIds.length ? new Set() : new Set(allIds),
    );
  }

  function clear() {
    setSelected(new Set());
  }

  return (
    <CallsSelectionContext.Provider
      value={{ selected, allIds, toggle, toggleAll, clear }}
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
