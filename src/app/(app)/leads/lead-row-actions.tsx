"use client";

import { Phone } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { Button } from "@/components/ui/button";

/** Hover-only action cluster on a leads row. Renders to the right of
 *  the cells.
 *
 *  v2 (round 6) — dropped the kebab dropdown entirely. The three menu
 *  items it hosted (Open in new tab, Mark DNC, Delete) have all been
 *  superseded:
 *    - Middle-mouse-button on the row opens a new tab (see lead-row.tsx)
 *    - Mark DNC + Delete are visible buttons on the lead detail hero
 *      (see lead-hero-actions.tsx)
 *  So the only action left on the row is Call — the high-frequency one.
 *  Less hover noise, fewer clicks to reach the destructive actions.
 *
 *  Stops click + keydown propagation so the surrounding TableRow's
 *  "navigate to /leads/<id>" handler doesn't fire when the user is
 *  acting *on* the row, not opening it. */
export function LeadRowActions({
  leadId,
  leadName,
}: {
  leadId: string;
  leadName: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function stop(event: React.SyntheticEvent) {
    event.stopPropagation();
  }

  function dispatchCallNow(event: React.MouseEvent) {
    event.stopPropagation();
    // Navigate to the detail page with ?action=call — the detail page
    // auto-opens the CallNowDialog. This keeps the "available
    // campaigns" lookup server-side and avoids reimplementing the
    // dialog at the row level.
    startTransition(() => {
      router.push(`/leads/${leadId}?action=call`);
    });
  }

  return (
    <div
      data-testid="lead-row-actions"
      onClick={stop}
      onKeyDown={stop}
      className="ml-auto flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
    >
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={dispatchCallNow}
        disabled={pending}
        className="h-7 px-2 text-[color:var(--coral)] hover:bg-[color:var(--coral)]/10 hover:text-[color:var(--coral)]"
        title={leadName ? `Call ${leadName} now` : "Call now"}
      >
        <Phone className="size-3.5" />
        Call
      </Button>
    </div>
  );
}
