"use client";

import { createContext, useContext, useState } from "react";

import { Checkbox } from "@/components/ui/checkbox";

type SelectionValue = {
  selected: Set<string>;
  selectedPhones: Map<string, string>;
  allIds: string[];
  toggle: (id: string, phone: string) => void;
  toggleAll: () => void;
  clear: () => void;
};

const SelectionContext = createContext<SelectionValue | null>(null);

/**
 * Tracks which DNC entries are checked. Resets whenever the visible rows
 * change (a new filter), so a bulk action never touches an entry the user
 * can no longer see.
 */
export function SelectionProvider({
  allRows,
  children,
}: {
  allRows: { id: string; phone: string }[];
  children: React.ReactNode;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedPhones, setSelectedPhones] = useState<Map<string, string>>(
    new Map(),
  );

  const allIds = allRows.map((r) => r.id);
  const allKey = allIds.join(",");
  const [seenKey, setSeenKey] = useState(allKey);
  if (seenKey !== allKey) {
    setSeenKey(allKey);
    setSelected(new Set());
    setSelectedPhones(new Map());
  }

  function toggle(id: string, phone: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setSelectedPhones((prev) => {
      const next = new Map(prev);
      if (next.has(id)) next.delete(id);
      else next.set(id, phone);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === allIds.length) {
      setSelected(new Set());
      setSelectedPhones(new Map());
    } else {
      setSelected(new Set(allIds));
      setSelectedPhones(new Map(allRows.map((r) => [r.id, r.phone])));
    }
  }

  function clear() {
    setSelected(new Set());
    setSelectedPhones(new Map());
  }

  return (
    <SelectionContext.Provider
      value={{ selected, selectedPhones, allIds, toggle, toggleAll, clear }}
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

/** Header checkbox that selects or clears every visible entry. */
export function SelectAllCheckbox() {
  const { selected, allIds, toggleAll } = useSelection();
  const allChecked =
    allIds.length > 0 && allIds.every((id) => selected.has(id));

  return (
    <Checkbox
      checked={allChecked}
      onCheckedChange={toggleAll}
      aria-label="Select all DNC entries"
    />
  );
}

/** Per-row checkbox. */
export function RowCheckbox({ id, phone }: { id: string; phone: string }) {
  const { selected, toggle } = useSelection();

  return (
    <Checkbox
      checked={selected.has(id)}
      onCheckedChange={() => toggle(id, phone)}
      aria-label={`Select ${phone}`}
    />
  );
}
