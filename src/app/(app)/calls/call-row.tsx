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

  // Click handler that bails when the click landed on a real <a>
  // tag inside the row (the company-name link, or any future link
  // we put in a cell). This lets <Link>s do their normal "navigate"
  // / "open new tab on middle-click" thing instead of getting
  // hijacked by the row's "open detail modal" handler. The button
  // check is the same idea — the row-actions cluster already stops
  // propagation, but clicks landing on a button (callbacks pill,
  // future inline edit, etc.) shouldn't open the modal either.
  function onRowClick(event: React.MouseEvent<HTMLTableRowElement>) {
    const target = event.target as HTMLElement;
    if (target.closest("a, button")) return;
    open();
  }

  return (
    <TableRow
      onClick={onRowClick}
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
