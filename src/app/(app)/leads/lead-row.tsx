"use client";

import { useRouter } from "next/navigation";

import { TableRow } from "@/components/ui/table";

/** A leads-table row that navigates to the full lead detail route at
 *  /leads/<id> when clicked. The lead page is a real route now (Close-
 *  style) instead of a query-param modal — so browser back works, the
 *  URL is shareable, and the page can scroll independently.
 *
 *  Cosmetic v2: the row is a `group` so children (e.g. row actions,
 *  hover rail) can react to hover. A 3px coral left-rail appears on
 *  hover via the `before:` pseudo-element. */
export function LeadRow({
  leadId,
  children,
}: {
  leadId: string;
  children: React.ReactNode;
}) {
  const router = useRouter();

  function open() {
    router.push(`/leads/${leadId}`);
  }

  return (
    <TableRow
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter") open();
      }}
      tabIndex={0}
      className="group hover:bg-muted/50 relative cursor-pointer before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-[color:var(--coral)] before:opacity-0 before:transition-opacity hover:before:opacity-100"
    >
      {children}
    </TableRow>
  );
}
