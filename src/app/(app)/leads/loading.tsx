import { Skeleton } from "@/components/ui/skeleton";

/** Route-level loading shell for /leads. Round 32 (V3) — gives the
 *  page a visible structure (title row → stat strip → toolbar →
 *  table) while the server resolves the leads query. The chips
 *  match the actual rendered heights so the jump on data arrival
 *  is minimal. */
export default function LeadsLoading() {
  return (
    <div className="flex flex-col gap-5 p-6">
      {/* Title row */}
      <div className="flex items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-4 w-48" />
        </div>
        <Skeleton className="h-9 w-28" />
      </div>

      {/* 3-tile stat strip */}
      <div className="border-border bg-card grid grid-cols-1 gap-x-4 gap-y-3 rounded-xl border px-5 py-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex flex-col gap-1.5 py-1">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-7 w-12" />
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-9 w-20" />
        <Skeleton className="h-9 w-24" />
      </div>

      {/* Table — 10 placeholder rows. */}
      <div className="border-border overflow-hidden rounded-xl border">
        <div className="bg-muted/40 flex items-center gap-4 px-4 py-2.5">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="ml-auto h-3 w-16" />
        </div>
        {Array.from({ length: 10 }).map((_, i) => (
          <div
            key={i}
            className="border-border bg-card flex items-center gap-4 border-t px-4 py-3"
          >
            <Skeleton className="size-4 rounded" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-4 w-44" />
              <Skeleton className="h-3 w-32" />
            </div>
            <Skeleton className="h-5 w-20 rounded-full" />
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
