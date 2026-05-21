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

const SelectionContext = createContext<SelectionValue | null>(null);

/**
 * Tracks which leads are checked on the current Leads view. The selection
 * resets whenever the visible rows change (a new page, filter, or sort), so
 * a bulk action never touches a lead the user can no longer see.
 */
export function SelectionProvider({
  allIds,
  children,
}: {
  allIds: string[];
  children: React.ReactNode;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Reset the selection when the visible leads change.
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
    <SelectionContext.Provider
      value={{ selected, allIds, toggle, toggleAll, clear }}
    >
      {children}
    </SelectionContext.Provider>
  );
}

export function useSelection(): SelectionValue {
  const ctx = useContext(SelectionContext);
  if (!ctx) {
    throw new Error("useSelection must be used within a SelectionProvider.");
  }
  return ctx;
}

/** Header checkbox that selects or clears every lead on the page. */
export function SelectAllCheckbox() {
  const { selected, allIds, toggleAll } = useSelection();
  const allChecked =
    allIds.length > 0 && allIds.every((id) => selected.has(id));

  return (
    <Checkbox
      checked={allChecked}
      onCheckedChange={toggleAll}
      aria-label="Select all leads"
    />
  );
}

/** Per-row checkbox. Clicks are kept from opening the lead detail modal. */
export function RowCheckbox({ leadId }: { leadId: string }) {
  const { selected, toggle } = useSelection();

  return (
    <span
      className="flex"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <Checkbox
        checked={selected.has(leadId)}
        onCheckedChange={() => toggle(leadId)}
        aria-label="Select lead"
      />
    </span>
  );
}
