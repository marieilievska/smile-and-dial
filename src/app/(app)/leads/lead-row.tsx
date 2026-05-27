"use client";

import { useRouter } from "next/navigation";

import { TableRow } from "@/components/ui/table";

/** A leads-table row that navigates to the full lead detail route at
 *  /leads/<id> when clicked.
 *
 *  v3 — dropped the `::before` pseudo-element hover rail. Pseudo-
 *  elements on table rows interact badly with `table-layout: fixed`:
 *  browsers can treat them as a phantom inline element that shifts
 *  every body cell one slot to the right, which is what was producing
 *  the "company name lands under the Status header" bug. The row
 *  still gets a hover background; if we want the coral rail back, the
 *  cleanest place is a `border-l-[3px] border-l-transparent
 *  group-hover:border-l-[color:var(--coral)]` on the first <td>. */
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
      className="group hover:bg-muted/50 cursor-pointer"
    >
      {children}
    </TableRow>
  );
}
