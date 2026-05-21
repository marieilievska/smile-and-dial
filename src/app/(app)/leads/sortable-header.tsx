import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import Link from "next/link";

import { TableHead } from "@/components/ui/table";

export function SortableHeader({
  label,
  column,
  currentSort,
  currentDir,
  query,
}: {
  label: string;
  column: string;
  currentSort: string;
  currentDir: "asc" | "desc";
  query: string;
}) {
  const isActive = currentSort === column;
  const nextDir = isActive && currentDir === "asc" ? "desc" : "asc";

  const params = new URLSearchParams();
  if (query) params.set("q", query);
  params.set("sort", column);
  params.set("dir", nextDir);

  return (
    <TableHead>
      <Link
        href={`/leads?${params.toString()}`}
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
