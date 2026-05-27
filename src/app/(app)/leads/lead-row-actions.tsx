"use client";

import { Ban, ExternalLink, MoreVertical, Phone, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { bulkAddLeadsToDnc } from "@/lib/dnc/actions";
import { bulkDeleteLeads } from "@/lib/leads/bulk-actions";

/** Hover-only action cluster on a leads row. Renders to the right of
 *  the cells. Two primary affordances:
 *   - Call now (coral, prominent) — dispatches a custom DOM event the
 *     page-level CallNowDialog listens for, so the dialog stays mounted
 *     once and doesn't need a per-row dialog instance.
 *   - More (kebab) — Open in new tab, Mark DNC, Delete.
 *
 *  Each interactive element stops click + keydown propagation so the
 *  surrounding TableRow's "navigate to /leads/<id>" handler doesn't
 *  fire when the user is acting *on* the row, not opening it. */
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
    router.push(`/leads/${leadId}?action=call`);
  }

  function openNewTab(event: React.MouseEvent) {
    event.stopPropagation();
    window.open(`/leads/${leadId}`, "_blank", "noopener");
  }

  function markDnc() {
    if (!confirm(`Mark ${leadName || "this lead"} as Do Not Call?`)) return;
    startTransition(async () => {
      const result = await bulkAddLeadsToDnc({ leadIds: [leadId] });
      if (result.error) toast.error(result.error);
      else {
        toast.success("Added to DNC.");
        router.refresh();
      }
    });
  }

  function softDelete() {
    if (!confirm(`Delete ${leadName || "this lead"}? This can be restored.`)) {
      return;
    }
    startTransition(async () => {
      const result = await bulkDeleteLeads({ leadIds: [leadId] });
      if (result.error) toast.error(result.error);
      else {
        toast.success("Lead deleted.");
        router.refresh();
      }
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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            disabled={pending}
            aria-label="More row actions"
            onClick={stop}
          >
            <MoreVertical className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={stop}>
          <DropdownMenuItem onClick={openNewTab}>
            <ExternalLink className="size-4" />
            Open in new tab
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={markDnc} variant="destructive">
            <Ban className="size-4" />
            Mark DNC
          </DropdownMenuItem>
          <DropdownMenuItem onClick={softDelete} variant="destructive">
            <Trash2 className="size-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
