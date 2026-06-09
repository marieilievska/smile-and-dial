"use client";

import { useRouter } from "next/navigation";

import { TableRow } from "@/components/ui/table";

/** A callbacks-table row that opens the call detail modal for the call this
 *  callback came from (the recording/transcript of where it was promised),
 *  via /calls?call=<callId>. Falls back to the lead detail route when there's
 *  no associated call. Mirrors the calls row pattern:
 *   - Click → router.push
 *   - Middle-click (mouse button 1) → window.open new tab
 *   - Clicks landing on <a> or <button> children fall through so the
 *     child link / action handles the event itself (the company-name
 *     link inside the primary cell, the action buttons on the right).
 */
export function CallbackRow({
  callId,
  leadId,
  children,
}: {
  callId: string | null;
  leadId: string | null;
  children: React.ReactNode;
}) {
  const router = useRouter();

  // Prefer the call detail modal; fall back to the lead page when there's no
  // call to show.
  const target = callId
    ? `/calls?call=${callId}`
    : leadId
      ? `/leads/${leadId}`
      : null;

  function open() {
    if (!target) return;
    router.push(target, { scroll: false });
  }

  function onMouseDown(event: React.MouseEvent) {
    if (!target) return;
    if (event.button === 1) {
      event.preventDefault();
      window.open(target, "_blank", "noopener");
    }
  }

  function onRowClick(event: React.MouseEvent<HTMLTableRowElement>) {
    const el = event.target as HTMLElement;
    if (el.closest("a, button")) return;
    open();
  }

  return (
    <TableRow
      onClick={onRowClick}
      onMouseDown={onMouseDown}
      onKeyDown={(event) => {
        if (event.key === "Enter") open();
      }}
      tabIndex={target ? 0 : -1}
      className={`group hover:bg-muted/50 ${
        target ? "cursor-pointer" : "cursor-default"
      }`}
    >
      {children}
    </TableRow>
  );
}
