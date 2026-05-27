import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import Link from "next/link";

import { TableHead } from "@/components/ui/table";

import { callbacksHref, type SearchParams } from "./callbacks-url";

/** Sortable column header for the Callbacks table. Same pattern as
 *  /calls' SortableHeader but URL-builds against /callbacks. */
export function SortableHeader({
  label,
  sortKey,
  currentSort,
  currentDir,
  params,
  className,
}: {
  label: string;
  sortKey: string;
  currentSort: string;
  currentDir: "asc" | "desc";
  params: SearchParams;
  className?: string;
}) {
  const isActive = currentSort === sortKey;
  // First click flips to desc; clicking an already-desc header goes
  // back to asc. Matches the convention on /calls.
  const nextDir = isActive && currentDir === "asc" ? "desc" : "asc";

  return (
    <TableHead className={className}>
      <Link
        href={callbacksHref(params, {
          sort: sortKey,
          dir: nextDir,
          page: "1",
        })}
        className="hover:text-foreground inline-flex items-center gap-1"
      >
        {label}
        {isActive ? (
          currentDir === "asc" ? (
            <ArrowUp className="size-3.5" />
          ) : (
            <ArrowDown className="size-3.5" />
          )
        ) : (
          <ChevronsUpDown className="size-3.5 opacity-50" />
        )}
      </Link>
    </TableHead>
  );
}
