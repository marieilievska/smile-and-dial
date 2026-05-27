"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

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
 *  All controls are URL-bound — page size lives in ?per.
 *
 *  Round 8 — visual rebuild. Buttons no longer use the shadcn Button
 *  primitive (which gave them a chunky, mismatched feel); they're now
 *  hand-tuned anchor / button elements sharing a single h-9 height,
 *  pill rounded-md, and a coherent hover/active palette:
 *   - default: text-foreground, hover:bg-muted/60
 *   - current page: bg-foreground text-background (high contrast)
 *   - disabled: muted-foreground, no hover
 *
 *  Reusable across list pages: pass `basePath` so it builds the right
 *  URLs (defaults to /leads for backward compatibility). */
export function SmartPagination({
  page,
  pageSize,
  total,
  basePath = "/leads",
}: {
  page: number;
  pageSize: number;
  total: number;
  basePath?: string;
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
    return `${basePath}?${params.toString()}`;
  }

  function setPageSize(next: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("per", next);
    params.delete("page");
    router.replace(`${basePath}?${params.toString()}`);
  }

  const pageNumbers = computePageNumbers(page, totalPages);
  const prevDisabled = page <= 1;
  const nextDisabled = page >= totalPages;

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
              className="h-8 w-[68px]"
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

      {/* Pagination cluster — a single visual unit with consistent
          spacing. Prev / page numbers / Next all share h-9 and the
          same rounded-md shape so they read as related controls. */}
      <nav
        aria-label="Pagination"
        className="border-border bg-background flex items-center gap-0.5 rounded-lg border p-1"
      >
        <PageButton
          href={prevDisabled ? null : hrefForPage(page - 1)}
          ariaLabel="Previous page"
        >
          <ChevronLeft className="size-4" />
          <span className="hidden sm:inline">Prev</span>
        </PageButton>
        {pageNumbers.map((p, i) =>
          p === "…" ? (
            <span
              key={`gap-${i}`}
              className="text-muted-foreground inline-flex h-9 min-w-9 items-center justify-center text-sm"
              aria-hidden
            >
              …
            </span>
          ) : (
            <PageButton
              key={p}
              href={p === page ? null : hrefForPage(p)}
              ariaLabel={`Page ${p}`}
              active={p === page}
            >
              <span className="tabular-nums">{p}</span>
            </PageButton>
          ),
        )}
        <PageButton
          href={nextDisabled ? null : hrefForPage(page + 1)}
          ariaLabel="Next page"
        >
          <span className="hidden sm:inline">Next</span>
          <ChevronRight className="size-4" />
        </PageButton>
      </nav>
    </div>
  );
}

/** Single page-number / arrow button inside the pagination cluster.
 *
 *  - Pass `href` to render an anchor (active, clickable state).
 *  - Pass `href={null}` for the disabled state (current page or out
 *    of range) — renders a non-interactive span.
 *  - Pass `active` to flip to the high-contrast filled treatment. */
function PageButton({
  href,
  ariaLabel,
  active = false,
  children,
}: {
  href: string | null;
  ariaLabel: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  const base =
    "inline-flex h-9 min-w-9 items-center justify-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors";
  if (active) {
    return (
      <span
        aria-current="page"
        aria-label={ariaLabel}
        className={`${base} bg-foreground text-background`}
      >
        {children}
      </span>
    );
  }
  if (!href) {
    return (
      <span
        aria-label={ariaLabel}
        aria-disabled="true"
        className={`${base} text-muted-foreground/60`}
      >
        {children}
      </span>
    );
  }
  return (
    <Link
      href={href}
      aria-label={ariaLabel}
      className={`${base} text-foreground hover:bg-muted/70`}
    >
      {children}
    </Link>
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
