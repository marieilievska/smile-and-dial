"use client";

import { useRouter } from "next/navigation";

import { TableRow } from "@/components/ui/table";

/** A leads-table row that navigates to the full lead detail route at
 *  /leads/<id> when clicked. The lead page is a real route now (Close-
 *  style) instead of a query-param modal — so browser back works, the
 *  URL is shareable, and the page can scroll independently. */
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
      className="hover:bg-muted/50 cursor-pointer"
    >
      {children}
    </TableRow>
  );
}
