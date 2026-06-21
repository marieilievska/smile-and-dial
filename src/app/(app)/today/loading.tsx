import { Skeleton } from "@/components/ui/skeleton";

/** Route-level loading shell for /today. Round 32 (V3) — Today fans
 *  out across hero counts, active calls, action queue, and pace —
 *  four parallel queries. Placeholder mirrors the actual greeting +
 *  live-calls band + hero pace + pace strip + action queue layout. */
export default function TodayLoading() {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6 lg:p-8">
      {/* Greeting */}
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-4 w-56" />
        <Skeleton className="mt-1 h-3 w-40" />
      </div>

      {/* Live calls band */}
      <div className="border-border bg-card flex items-center justify-between gap-4 rounded-2xl border p-5 shadow-sm">
        <div className="flex items-center gap-3">
          <Skeleton className="size-10 rounded-full" />
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-4 w-48" />
          </div>
        </div>
        <Skeleton className="h-9 w-24" />
      </div>

      {/* Hero pace */}
      <div className="border-border bg-card flex flex-col gap-4 rounded-2xl border p-6 shadow-sm md:flex-row md:items-end md:justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-10 w-20" />
          <Skeleton className="h-4 w-56" />
        </div>
        <Skeleton className="h-20 w-full md:w-80" />
      </div>

      {/* Pace strip — 3 tiles */}
      <div className="border-border bg-card grid grid-cols-1 gap-x-4 gap-y-3 rounded-2xl border px-5 py-4 shadow-sm sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex flex-col gap-1.5 py-1">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-6 w-12" />
          </div>
        ))}
      </div>

      {/* Action queue */}
      <div className="flex flex-col gap-3">
        <Skeleton className="h-5 w-24" />
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="border-border bg-card flex items-center gap-4 rounded-2xl border p-4 shadow-sm"
          >
            <Skeleton className="size-9 rounded-lg" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-4 w-64" />
              <Skeleton className="h-3 w-40" />
            </div>
            <Skeleton className="h-8 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}
