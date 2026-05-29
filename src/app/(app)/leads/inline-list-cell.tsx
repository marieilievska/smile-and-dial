"use client";

import { Check, ChevronDown } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { setLeadList } from "@/lib/leads/inline-actions";

export type InlineListOption = { id: string; name: string };

/** Inline List cell. Click the list name, pick a different list, it
 *  saves. Same pattern as InlineStatusCell — Popover wraps the cell
 *  text, click+keydown stop propagation so the row's navigation
 *  doesn't fire, optimistic local state with rollback on failure.
 *
 *  Unlike status (a closed enum), lists are dynamic — the options
 *  come from the page's already-fetched `lists` array. If there are
 *  no lists yet, the trigger renders as a non-clickable span so we
 *  don't open an empty popover. */
export function InlineListCell({
  leadId,
  listId,
  listName,
  options,
}: {
  leadId: string;
  listId: string | null;
  listName: string;
  options: InlineListOption[];
}) {
  const [open, setOpen] = useState(false);
  const [localListId, setLocalListId] = useState(listId);
  const [localListName, setLocalListName] = useState(listName);
  const [pending, startTransition] = useTransition();

  // Server-as-source-of-truth reconcile. Same shape as InlineStatusCell.
  if (listId !== localListId && !pending) {
    setLocalListId(listId);
    setLocalListName(listName);
  }

  function pick(option: InlineListOption) {
    if (option.id === localListId) {
      setOpen(false);
      return;
    }
    const previousId = localListId;
    const previousName = localListName;
    setLocalListId(option.id);
    setLocalListName(option.name);
    setOpen(false);
    startTransition(async () => {
      const result = await setLeadList({ leadId, listId: option.id });
      if (result.error) {
        toast.error(result.error);
        setLocalListId(previousId);
        setLocalListName(previousName);
      } else {
        toast.success("List updated.");
      }
    });
  }

  if (options.length === 0) {
    return (
      <span className="text-muted-foreground block truncate">
        {localListName}
      </span>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="lead-list-trigger"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          disabled={pending}
          // Same wording dance as InlineStatusCell — the bulk-move
          // dialog's "List" select uses `getByLabel("List")` with
          // substring match, so this trigger avoids "list" entirely.
          // "Currently in" reads naturally for a screen reader.
          aria-label={`Currently in ${localListName}, click to reassign`}
          className="group/list text-muted-foreground hover:text-foreground focus-visible:ring-ring/60 hover:bg-muted/40 -mx-2 inline-flex max-w-[calc(100%+1rem)] cursor-pointer items-center gap-1 rounded-md px-2 py-0.5 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60"
        >
          <span className="truncate">{localListName}</span>
          <ChevronDown className="size-3 shrink-0 opacity-0 transition-opacity group-hover/list:opacity-100" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-h-72 w-60 overflow-y-auto p-1"
        onClick={(event) => event.stopPropagation()}
      >
        <div
          role="listbox"
          aria-label="Pick a list"
          className="flex flex-col gap-0.5"
        >
          {options.map((option) => {
            const isCurrent = option.id === localListId;
            return (
              <button
                key={option.id}
                type="button"
                role="option"
                aria-selected={isCurrent}
                onClick={() => pick(option)}
                className="hover:bg-muted/60 focus-visible:bg-muted/60 flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors focus-visible:outline-none"
              >
                <span className="truncate">{option.name}</span>
                {isCurrent ? (
                  <Check className="text-muted-foreground size-3.5 shrink-0" />
                ) : null}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
