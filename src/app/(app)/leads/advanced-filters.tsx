"use client";

import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";

/** Opt-in wrapper for the advanced Filter Builder (and, for admins, the
 *  Smart List picker). Collapsed by default so the page presents ONE filter
 *  entry point — the basic Filters popover in the toolbar — with advanced
 *  filtering a click away, instead of two filter systems side by side. Opens
 *  automatically when a recipe is already applied. */
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
