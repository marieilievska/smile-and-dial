"use client";

import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";

/** Opt-in wrapper for the advanced Filter Builder. Collapsed by default so the
 *  page presents ONE filter entry point — the basic Filters popover in the
 *  toolbar — with advanced filtering a click away, instead of two filter
 *  systems side by side. Opens automatically when a recipe is already applied.
 *
 *  The auto-updating-list picker used to live in here too, and should not come
 *  back: it is the only control on the page that can feed the dialer, and
 *  hiding it behind a button labelled "Advanced filter" is most of why nobody
 *  ever made one. It now renders above this panel. Building a filter is an
 *  advanced thing; opening a list you already saved is not. */
export function AdvancedFilters({
  defaultOpen,
  children,
}: {
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="text-muted-foreground hover:text-foreground w-fit gap-1.5"
      >
        <SlidersHorizontal className="size-4" />
        Advanced filter
        <ChevronDown
          className={`size-4 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </Button>
      {open ? children : null}
    </div>
  );
}
