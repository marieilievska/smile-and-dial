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

const CallbacksSelectionContext = createContext<SelectionValue | null>(null);

/**
 * Tracks which callbacks are checked on the current view (admin-only, for bulk
 * delete). Resets whenever the visible rows change — a new page, filter, or
 * sort — so a delete never touches a row the user can no longer see.
 */
export function CallbacksSelectionProvider({
  allIds,
  children,
}: {
  allIds: string[];
  children: React.ReactNode;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

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
    <CallbacksSelectionContext.Provider
      value={{ selected, allIds, toggle, toggleAll, clear }}
    >
      {children}
    </CallbacksSelectionContext.Provider>
  );
}

export function useCallbacksSelection(): SelectionValue {
  const ctx = useContext(CallbacksSelectionContext);
  if (!ctx) {
    throw new Error(
      "useCallbacksSelection must be used within a CallbacksSelectionProvider.",
    );
  }
  return ctx;
}

/** Header checkbox that selects or clears every callback on the page. */
export function CallbackSelectAllCheckbox() {
  const { selected, allIds, toggleAll } = useCallbacksSelection();
  const allChecked =
    allIds.length > 0 && allIds.every((id) => selected.has(id));
  return (
    <Checkbox
      checked={allChecked}
      onCheckedChange={toggleAll}
      aria-label="Select all callbacks"
    />
  );
}

/** Per-row checkbox. Stops propagation so checking it doesn't trigger the
 *  row's open-lead navigation. */
export function CallbackRowCheckbox({ callbackId }: { callbackId: string }) {
  const { selected, toggle } = useCallbacksSelection();
  return (
    <span
      className="flex"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <Checkbox
        checked={selected.has(callbackId)}
        onCheckedChange={() => toggle(callbackId)}
        aria-label="Select callback"
      />
    </span>
  );
}
