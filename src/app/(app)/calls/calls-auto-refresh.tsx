"use client";

import { AutoRefresh } from "@/components/auto-refresh";

/**
 * Live-updates the Calls page. Thin wrapper over the shared <AutoRefresh>: polls
 * faster while calls are in flight, pauses on a hidden tab, and holds off while
 * a dialog/popover is open so the call-detail modal stays snappy.
 */
export function CallsAutoRefresh({ hasActive }: { hasActive: boolean }) {
  return <AutoRefresh active={hasActive} />;
}
