"use client";

import { createContext, useContext, useRef, useState } from "react";

import { Checkbox } from "@/components/ui/checkbox";

type SelectionValue = {
  selected: Set<string>;
  allIds: string[];
  /** When true, the user clicked "Select all N matching" — the selection
   *  spans every match across pages, not just the visible page. The set
   *  in `selected` is the materialized list (capped). */
  matchAll: boolean;
  toggle: (id: string) => void;
  /** Round 33 (I4) — shift-click range. Selects every lead between the
   *  last anchor and the supplied id (inclusive) in the order they
   *  appear in `allIds`. If there's no anchor yet, behaves like a
   *  plain toggle. */
  toggleRange: (id: string) => void;
  toggleAll: () => void;
  setMatchAllSelection: (ids: string[]) => void;
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
  const [matchAll, setMatchAll] = useState(false);
  // Anchor for shift-click range. Holds the last id the user toggled
  // with a plain click; shift-click fills from this id to the new id.
  // A ref keeps it stable across renders without forcing a re-render
  // on every toggle.
  const anchorRef = useRef<string | null>(null);

  // Reset the selection when the visible leads change.
  const allKey = allIds.join(",");
  const [seenKey, setSeenKey] = useState(allKey);
  if (seenKey !== allKey) {
    setSeenKey(allKey);
    setSelected(new Set());
    setMatchAll(false);
    // Ref reset is paired with the state reset above and only fires
    // when the visible-leads identity changes — not on every render.
    // eslint-disable-next-line react-hooks/refs
    anchorRef.current = null;
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    anchorRef.current = id;
    // Any individual toggle escapes match-all mode — the user is now
    // hand-picking, not sweeping.
    if (matchAll) setMatchAll(false);
  }

  function toggleRange(id: string) {
    const anchor = anchorRef.current;
    if (!anchor || anchor === id) {
      toggle(id);
      return;
    }
    const fromIdx = allIds.indexOf(anchor);
    const toIdx = allIds.indexOf(id);
    if (fromIdx === -1 || toIdx === -1) {
      toggle(id);
      return;
    }
    const [lo, hi] = fromIdx <= toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
    // The anchor's current state decides the range's target state:
    // if the anchor is currently selected, shift-click fills the range
    // with selection; if it's deselected, it clears the range. Mirrors
    // Gmail / Linear / Notion behaviour.
    const fill = selected.has(anchor);
    setSelected((prev) => {
      const next = new Set(prev);
      for (let i = lo; i <= hi; i++) {
        if (fill) next.add(allIds[i]);
        else next.delete(allIds[i]);
      }
      return next;
    });
    // Don't move the anchor — the next shift-click should still pivot
    // from the original anchor, matching Gmail.
    if (matchAll) setMatchAll(false);
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size === allIds.length ? new Set() : new Set(allIds),
    );
    // Toggling page-level select-all leaves match-all mode if it was
    // engaged; user can re-engage via the banner.
    setMatchAll(false);
  }

  function setMatchAllSelection(ids: string[]) {
    setSelected(new Set(ids));
    setMatchAll(true);
  }

  function clear() {
    setSelected(new Set());
    setMatchAll(false);
    anchorRef.current = null;
  }

  return (
    <SelectionContext.Provider
      value={{
        selected,
        allIds,
        matchAll,
        toggle,
        toggleRange,
        toggleAll,
        setMatchAllSelection,
        clear,
      }}
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

/** Per-row checkbox. Clicks are kept from opening the lead detail modal.
 *  Round 33 (I4) — shift-click fills (or clears) the range from the
 *  last anchor to this row, matching Gmail / Linear / Notion. We
 *  listen at the wrapper level so the modifier state is captured
 *  before Radix's onCheckedChange handler runs. */
export function RowCheckbox({ leadId }: { leadId: string }) {
  const { selected, toggle, toggleRange } = useSelection();

  function onClick(event: React.MouseEvent) {
    event.stopPropagation();
    // Radix Checkbox dispatches its own click that we want to suppress
    // when shift is held — we'll drive the state ourselves from the
    // range helper. preventDefault stops the underlying checkbox from
    // also flipping, which would double-handle.
    if (event.shiftKey) {
      event.preventDefault();
      toggleRange(leadId);
    }
  }

  return (
    <span
      className="flex"
      onClick={onClick}
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
