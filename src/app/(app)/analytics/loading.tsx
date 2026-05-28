import { Skeleton } from "@/components/ui/skeleton";

/** Route-level loading shell for /analytics. Round 32 (V3) — the
 *  analytics queries are the heaviest in the app (KPIs + funnels +
 *  bookings-over-time + outcome breakdown), so a placeholder
 *  matters more here than anywhere else. */
export default function AnalyticsLoading() {
  return (
    <div className="flex flex-col gap-5 p-6">
      {/* Title + range chips */}
      <div className="flex items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-40" />
        </div>
        <Skeleton className="h-9 w-72" />
      </div>

      {/* KPI tiles */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="border-border bg-card flex flex-col gap-2 rounded-xl border p-4"
          >
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>

      {/* Two big chart panels side-by-side on lg */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="border-border bg-card flex flex-col gap-3 rounded-xl border p-5"
          >
            <div className="flex items-baseline justify-between">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-28" />
            </div>
            <Skeleton className="h-40 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
