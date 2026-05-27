"use client";

import { useRouter } from "next/navigation";

import { TableRow } from "@/components/ui/table";

/** A callbacks-table row that navigates to the full lead detail route
 *  at /leads/<leadId> when clicked. Mirrors the calls row pattern:
 *   - Click → router.push
 *   - Middle-click (mouse button 1) → window.open new tab
 *   - Clicks landing on <a> or <button> children fall through so the
 *     child link / action handles the event itself (the company-name
 *     link inside the primary cell, the action buttons on the right).
 */
export function CallbackRow({
  leadId,
  children,
}: {
  leadId: string | null;
  children: React.ReactNode;
}) {
  const router = useRouter();

  function open() {
    if (!leadId) return;
    router.push(`/leads/${leadId}`);
  }

  function onMouseDown(event: React.MouseEvent) {
    if (!leadId) return;
    if (event.button === 1) {
      event.preventDefault();
      window.open(`/leads/${leadId}`, "_blank", "noopener");
    }
  }

  function onRowClick(event: React.MouseEvent<HTMLTableRowElement>) {
    const target = event.target as HTMLElement;
    if (target.closest("a, button")) return;
    open();
  }

  return (
    <TableRow
      onClick={onRowClick}
      onMouseDown={onMouseDown}
      onKeyDown={(event) => {
        if (event.key === "Enter") open();
      }}
      tabIndex={leadId ? 0 : -1}
      className={`group hover:bg-muted/50 ${
        leadId ? "cursor-pointer" : "cursor-default"
      }`}
    >
      {children}
    </TableRow>
  );
}
