"use client";

import { Search } from "lucide-react";

import { Button } from "@/components/ui/button";

/** Points at (and focuses) the global search in the top bar — which is where
 *  call search lives (type there and press Enter to filter /calls). Without
 *  it, a teammate on /calls has no on-page signal for where to search. */
export function CallsSearchHint() {
  function focusSearch() {
    const el = document.querySelector<HTMLInputElement>(
      '[data-testid="global-search"] input',
    );
    if (el) {
      el.focus();
      el.select();
    }
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={focusSearch}
      title="Search calls — the box is in the top bar (⌘K)"
      className="text-muted-foreground hover:text-foreground gap-1.5"
    >
      <Search className="size-4" />
      Search
    </Button>
  );
}
