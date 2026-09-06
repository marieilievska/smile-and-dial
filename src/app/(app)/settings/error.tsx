"use client";

import { RouteError } from "@/components/app-shell/route-error";

/** Boundary for the whole settings segment. It renders INSIDE settings/layout.tsx, so a failure on one settings page keeps the left rail and the user can click straight to another section instead of losing the whole area. */
export default function SettingsError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <RouteError
      error={error}
      retry={unstable_retry}
      surface="your settings"
      hint="That settings page didn't load. The rest of your settings are still available in the list beside this."
      backHref="/settings/overview"
      backLabel="Settings overview"
    />
  );
}
