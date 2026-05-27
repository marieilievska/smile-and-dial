"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const PAGE_SIZES = [25, 50, 100] as const;

/** Bottom pagination control: "Showing N–M of total" + rows-per-page +
 *  page-numbered controls with ellipses. Replaces the v1 Prev/Next pair.
 *  All controls are URL-bound — page size lives in ?per. */
export function SmartPagination({
  page,
  pageSize,
  total,
}: {
  page: number;
  pageSize: number;
  total: number;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  if (total === 0) return null;

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(total, page * pageSize);

  function hrefForPage(next: number): string {
    const params = new URLSearchParams(searchParams.toString());
    params.set("page", String(next));
    return `/leads?${params.toString()}`;
  }

  function setPageSize(next: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("per", next);
    params.delete("page");
    router.replace(`/leads?${params.toString()}`);
  }

  const pageNumbers = computePageNumbers(page, totalPages);

  return (
    <div
      data-testid="smart-pagination"
      className="flex flex-wrap items-center justify-between gap-3"
    >
      <div className="text-muted-foreground flex items-center gap-3 text-sm">
        <span className="tabular-nums">
          Showing{" "}
          <span className="text-foreground font-medium">
            {start}–{end}
          </span>{" "}
          of{" "}
          <span className="text-foreground font-medium">
            {total.toLocaleString()}
          </span>
        </span>
        <div className="flex items-center gap-1.5">
          <span className="text-xs">Rows</span>
          <Select value={String(pageSize)} onValueChange={setPageSize}>
            <SelectTrigger
              size="sm"
              className="h-7 w-[68px]"
              aria-label="Rows per page"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex items-center gap-1">
        <Button
          asChild={page > 1}
          variant="ghost"
          size="sm"
          disabled={page <= 1}
          aria-label="Previous page"
        >
          {page > 1 ? (
            <Link href={hrefForPage(page - 1)}>
              <ChevronLeft className="size-4" />
              Prev
            </Link>
          ) : (
            <span>
              <ChevronLeft className="size-4" />
              Prev
            </span>
          )}
        </Button>
        {pageNumbers.map((p, i) =>
          p === "…" ? (
            <span
              key={`gap-${i}`}
              className="text-muted-foreground px-1.5 text-xs"
            >
              …
            </span>
          ) : (
            <Button
              key={p}
              asChild={p !== page}
              variant={p === page ? "default" : "ghost"}
              size="sm"
              className="h-7 min-w-7 px-2 text-xs"
              aria-current={p === page ? "page" : undefined}
              aria-label={`Page ${p}`}
            >
              {p === page ? (
                <span>{p}</span>
              ) : (
                <Link href={hrefForPage(p)}>{p}</Link>
              )}
            </Button>
          ),
        )}
        <Button
          asChild={page < totalPages}
          variant="ghost"
          size="sm"
          disabled={page >= totalPages}
          aria-label="Next page"
        >
          {page < totalPages ? (
            <Link href={hrefForPage(page + 1)}>
              Next
              <ChevronRight className="size-4" />
            </Link>
          ) : (
            <span>
              Next
              <ChevronRight className="size-4" />
            </span>
          )}
        </Button>
      </div>
    </div>
  );
}

/** Page-numbers with ellipses. Always shows 1, the current page +/- 1,
 *  and the last page. E.g. for 27 pages on page 12:
 *  [1, …, 11, 12, 13, …, 27]. */
function computePageNumbers(
  page: number,
  totalPages: number,
): (number | "…")[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const pages: (number | "…")[] = [1];
  const start = Math.max(2, page - 1);
  const end = Math.min(totalPages - 1, page + 1);
  if (start > 2) pages.push("…");
  for (let p = start; p <= end; p++) pages.push(p);
  if (end < totalPages - 1) pages.push("…");
  pages.push(totalPages);
  return pages;
}
