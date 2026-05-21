"use client";

import { useRouter, useSearchParams } from "next/navigation";

import { TableRow } from "@/components/ui/table";

/**
 * A leads-table row that opens the lead detail modal when clicked. The
 * selected lead is tracked in the URL (`?lead=<id>`) so the modal survives
 * a refresh and can be linked to directly.
 */
export function LeadRow({
  leadId,
  children,
}: {
  leadId: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function open() {
    const params = new URLSearchParams(searchParams.toString());
    params.set("lead", leadId);
    router.push(`/leads?${params.toString()}`);
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
