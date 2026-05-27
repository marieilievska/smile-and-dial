"use client";

import { useRouter, useSearchParams } from "next/navigation";

import { TableRow } from "@/components/ui/table";

/**
 * A calls-table row that opens the call detail modal when clicked. The
 * selected call is tracked in the URL (`?call=<id>`) so the modal survives
 * a refresh and can be linked to directly.
 */
export function CallRow({
  callId,
  children,
}: {
  callId: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function open() {
    const params = new URLSearchParams(searchParams.toString());
    params.set("call", callId);
    router.push(`/calls?${params.toString()}`, { scroll: false });
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
