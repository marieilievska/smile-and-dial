"use client";

import { ArrowRightLeft, Loader2, X } from "lucide-react";
import {
  createContext,
  useContext,
  useMemo,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { moveNumbersToCampaign } from "@/lib/twilio/pool-actions";

type Campaign = { id: string; name: string };

type BulkMoveContext = {
  /** Every selectable (in-pool) number id currently on screen. */
  allIds: string[];
  selected: Set<string>;
  toggle: (id: string) => void;
  toggleAll: () => void;
  clear: () => void;
};

const Ctx = createContext<BulkMoveContext | null>(null);

function useBulkMove(): BulkMoveContext {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error("Bulk-move components must be inside <BulkMoveProvider>.");
  }
  return ctx;
}

/**
 * Holds the numbers-table row selection and renders the bulk-action bar above
 * the table. The (server-rendered) table is passed as `children`; the per-row
 * checkboxes are client components that read this context — so the server table
 * stays intact and only gains a thin interactive layer. `allIds` is the set of
 * in-pool numbers currently visible (released rows aren't selectable).
 */
export function BulkMoveProvider({
  allIds,
  campaigns,
  children,
}: {
  allIds: string[];
  campaigns: Campaign[];
  children: ReactNode;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const value = useMemo<BulkMoveContext>(
    () => ({
      allIds,
      selected,
      toggle: (id) =>
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        }),
      toggleAll: () =>
        setSelected((prev) =>
          allIds.length > 0 && allIds.every((id) => prev.has(id))
            ? new Set()
            : new Set(allIds),
        ),
      clear: () => setSelected(new Set()),
    }),
    [allIds, selected],
  );

  return (
    <Ctx.Provider value={value}>
      <div className="flex flex-col gap-3">
        <BulkMoveBar campaigns={campaigns} />
        {children}
      </div>
    </Ctx.Provider>
  );
}

/** The action bar — only visible once at least one number is selected. Lets you
 *  send the whole selection to one campaign in a single action. */
function BulkMoveBar({ campaigns }: { campaigns: Campaign[] }) {
  const { selected, clear } = useBulkMove();
  const [campaignId, setCampaignId] = useState("");
  const [pending, startTransition] = useTransition();
  const count = selected.size;

  if (count === 0) return null;

  function move() {
    if (!campaignId) {
      toast.error("Pick a campaign to move to.");
      return;
    }
    const ids = [...selected];
    const dest = campaigns.find((c) => c.id === campaignId);
    startTransition(async () => {
      try {
        const result = await moveNumbersToCampaign(ids, campaignId);
        if (result.error) {
          toast.error(result.error);
          return;
        }
        const skipped = result.failed > 0 ? ` (${result.failed} skipped)` : "";
        toast.success(
          `Moved ${result.moved} ${result.moved === 1 ? "number" : "numbers"} to ${dest?.name ?? "the campaign"}.${skipped}`,
        );
        clear();
        setCampaignId("");
      } catch {
        toast.error("Something went wrong. Please try again.");
      }
    });
  }

  return (
    <div className="border-border bg-card flex flex-wrap items-center gap-3 rounded-xl border p-3 shadow-sm">
      <span className="text-foreground text-sm font-medium">
        {count} selected
      </span>
      <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
        <Select value={campaignId} onValueChange={setCampaignId}>
          <SelectTrigger className="w-56" aria-label="Move to campaign">
            <SelectValue placeholder="Move to campaign…" />
          </SelectTrigger>
          <SelectContent>
            {campaigns.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button onClick={move} disabled={pending || !campaignId}>
          {pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <ArrowRightLeft className="size-4" />
          )}
          Move
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={clear}
          disabled={pending}
          aria-label="Clear selection"
        >
          <X className="size-4" />
        </Button>
      </div>
    </div>
  );
}

/** Header checkbox: selects / clears every in-pool number on screen. Shows an
 *  indeterminate state when only some are selected. */
export function SelectAllNumbersCheckbox() {
  const { allIds, selected, toggleAll } = useBulkMove();
  if (allIds.length === 0) return null;
  const allSelected = allIds.every((id) => selected.has(id));
  const checked = allSelected
    ? true
    : selected.size > 0
      ? "indeterminate"
      : false;
  return (
    <Checkbox
      checked={checked}
      onCheckedChange={toggleAll}
      aria-label={allSelected ? "Clear all numbers" : "Select all numbers"}
    />
  );
}

/** Per-row checkbox. Released numbers can't be moved, so they render no
 *  checkbox at all (an empty cell) rather than a disabled one. */
export function NumberSelectCheckbox({
  id,
  phone,
  disabled,
}: {
  id: string;
  phone: string;
  disabled?: boolean;
}) {
  const { selected, toggle } = useBulkMove();
  if (disabled) return null;
  return (
    <Checkbox
      checked={selected.has(id)}
      onCheckedChange={() => toggle(id)}
      aria-label={`Select ${phone}`}
    />
  );
}
