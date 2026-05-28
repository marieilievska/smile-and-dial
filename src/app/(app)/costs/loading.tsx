import { Skeleton } from "@/components/ui/skeleton";

/** Route-level loading shell for /costs. Round 32 (V3) — the costs
 *  page fans out into multiple rollups; this placeholder mirrors
 *  the actual rendered layout (title + date pills + 3-stat strip +
 *  view tabs + table) so the layout doesn't reflow on data arrival. */
export default function CostsLoading() {
  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-7 w-44" />
            <Skeleton className="h-4 w-56" />
          </div>
          <Skeleton className="h-9 w-32" />
        </div>
        <Skeleton className="h-9 w-72" />
      </div>

      {/* 3-tile stat strip */}
      <div className="border-border bg-card grid grid-cols-1 gap-x-4 gap-y-3 rounded-xl border px-5 py-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex flex-col gap-1.5 py-1">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-7 w-20" />
          </div>
        ))}
      </div>

      {/* View tabs */}
      <Skeleton className="h-9 w-80" />

      {/* Table */}
      <div className="border-border overflow-hidden rounded-xl border">
        <div className="bg-muted/40 flex items-center gap-4 px-4 py-2.5">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="ml-auto h-3 w-16" />
        </div>
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="border-border bg-card flex items-center gap-4 border-t px-4 py-3"
          >
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-4 w-40" />
            </div>
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-12" />
          </div>
        ))}
      </div>
    </div>
  );
}
