"use client";

import { RouteError } from "@/components/app-shell/route-error";

/** Catch-all boundary for any /(app) route without a closer one. Renders
 *  inside the shell, so the sidebar and top bar stay put.
 *
 *  Segments with their own error.tsx (settings, analytics, costs, reporting,
 *  lead detail) never reach this one — theirs keeps more of the surrounding
 *  page intact, and names what broke. */
export default function AppError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return <RouteError error={error} retry={unstable_retry} />;
}
