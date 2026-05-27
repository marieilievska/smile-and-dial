import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import Link from "next/link";

import { TableHead } from "@/components/ui/table";

import { callsHref, type SearchParams } from "./calls-url";

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
  const nextDir = isActive && currentDir === "desc" ? "asc" : "desc";

  return (
    <TableHead className={className}>
      <Link
        href={callsHref(params, { sort: sortKey, dir: nextDir, page: "1" })}
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
