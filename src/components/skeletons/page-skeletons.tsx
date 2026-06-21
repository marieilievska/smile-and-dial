import { Skeleton } from "@/components/ui/skeleton";

/** Shared route-level loading skeletons. Each mirrors the real page's
 *  silhouette — header, stat strip, then content — so the layout doesn't
 *  jump when data lands. Used from route loading.tsx files; rendered by
 *  Next.js while the server component streams.
 *
 *  The whole tree is aria-hidden via the Skeleton primitive and carries a
 *  visually-hidden "Loading…" status for screen readers. */

function LoadingStatus() {
  return (
    <span role="status" className="sr-only">
      Loading…
    </span>
  );
}

function PageHeaderSkeleton({ action = true }: { action?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-44" />
        <Skeleton className="h-4 w-72" />
      </div>
      {action ? <Skeleton className="h-9 w-32 rounded-lg" /> : null}
    </div>
  );
}

function StatStripSkeleton({ tiles = 4 }: { tiles?: number }) {
  return (
    <div className="border-border bg-card grid grid-cols-2 gap-4 rounded-2xl border px-5 py-4 shadow-sm sm:grid-cols-4">
      {Array.from({ length: tiles }).map((_, i) => (
        <div key={i} className="flex flex-col gap-2">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-6 w-16" />
        </div>
      ))}
    </div>
  );
}

function TableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="border-border overflow-hidden rounded-2xl border shadow-sm">
      <div className="border-border bg-muted/40 flex items-center gap-4 border-b px-4 py-3">
        <Skeleton className="h-3.5 w-32" />
        <Skeleton className="h-3.5 w-24" />
        <Skeleton className="ml-auto h-3.5 w-20" />
      </div>
      <div className="flex flex-col">
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="border-border/60 flex items-center gap-4 border-b px-4 py-3 last:border-b-0"
          >
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-28" />
            <Skeleton className="ml-auto h-6 w-16 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Header + stat strip + table — the shape of Leads, Calls, Callbacks,
 *  Campaigns, DNC, Goals, etc. */
export function TablePageSkeleton({
  tiles = 4,
  rows = 8,
  action = true,
}: {
  tiles?: number;
  rows?: number;
  action?: boolean;
}) {
  return (
    <div className="flex flex-col gap-5 p-6">
      <LoadingStatus />
      <PageHeaderSkeleton action={action} />
      <StatStripSkeleton tiles={tiles} />
      <div className="flex flex-wrap items-center gap-3">
        <Skeleton className="h-8 w-64 rounded-lg" />
        <Skeleton className="ml-auto h-8 w-28 rounded-lg" />
      </div>
      <TableSkeleton rows={rows} />
    </div>
  );
}

/** Header + hero + KPI grid + chart — the shape of Analytics, Costs,
 *  Today. */
export function DashboardSkeleton({ tiles = 5 }: { tiles?: number }) {
  return (
    <div className="flex flex-col gap-5 p-6">
      <LoadingStatus />
      <PageHeaderSkeleton />
      <Skeleton className="h-28 w-full rounded-2xl" />
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: tiles }).map((_, i) => (
          <div
            key={i}
            className="border-border bg-card flex flex-col gap-2 rounded-2xl border px-5 py-4 shadow-sm"
          >
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-7 w-16" />
            <Skeleton className="h-3 w-12" />
          </div>
        ))}
      </div>
      <Skeleton className="h-64 w-full rounded-2xl" />
    </div>
  );
}
