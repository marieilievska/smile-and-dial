import { cn } from "@/lib/utils";

/** Skeleton block — pulsing muted rectangle, used inside `loading.tsx`
 *  files to give the route a visual placeholder while the server is
 *  fetching. Round 32 (V3) — the app's data-heavy pages (leads,
 *  analytics, costs) used to flash a blank canvas while Suspense
 *  awaited; these chips keep the layout structure visible so the
 *  jump on first paint is gone.
 *
 *  Reduced-motion: the global `prefers-reduced-motion` rule in
 *  globals.css already kills the pulse animation, so users who've
 *  opted out get a still placeholder. */
export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("bg-muted/70 animate-pulse rounded-md", className)}
      {...props}
    />
  );
}
