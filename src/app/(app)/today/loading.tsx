import { Skeleton } from "@/components/ui/skeleton";

/** Route-level loading shell for /today. Round 41 — mirrors the reordered
 *  layout: a compact greeting, then "Up next" in the wide left column with
 *  the live-calls rail, then the consolidated metric row below. */
export default function TodayLoading() {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6 lg:p-8">
      {/* Compact greeting header */}
      <div className="border-border bg-card flex items-center justify-between rounded-2xl border p-5 shadow-sm">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-7 w-64" />
          <Skeleton className="h-4 w-56" />
        </div>
        <Skeleton className="hidden h-4 w-52 md:block" />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:items-start">
        {/* Up next — wide left column */}
        <div className="flex flex-col gap-3 lg:col-span-2">
          <Skeleton className="h-5 w-24" />
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="border-border bg-card flex items-center gap-4 rounded-xl border p-4 shadow-sm"
            >
              <Skeleton className="size-10 rounded-full" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-4 w-64" />
                <Skeleton className="h-3 w-40" />
              </div>
            </div>
          ))}
        </div>

        {/* Live calls rail */}
        <div className="border-border bg-card flex items-center gap-3 rounded-2xl border px-4 py-3 shadow-sm lg:col-span-1">
          <Skeleton className="size-2.5 rounded-full" />
          <Skeleton className="h-4 w-40" />
        </div>

        {/* Consolidated metric row — 4 tiles */}
        <div className="lg:col-span-3">
          <div className="border-border bg-card grid grid-cols-2 gap-x-4 gap-y-5 rounded-2xl border px-6 py-5 shadow-sm sm:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex flex-col gap-1.5">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-6 w-12" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
