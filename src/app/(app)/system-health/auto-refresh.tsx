"use client";

import { Pause, Play } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

/** Small toggle that flips ?auto=1 / 0 and, when on, re-fetches the page
 *  every 10s via router.refresh(). Per BUILD_PLAN §5.10. */
export function AutoRefresh({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const params = useSearchParams();

  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(() => router.refresh(), 10_000);
    return () => clearInterval(interval);
  }, [enabled, router]);

  const next = new URLSearchParams(params.toString());
  next.set("auto", enabled ? "0" : "1");
  const href = `/system-health?${next.toString()}`;

  return (
    <div className="flex items-center gap-3">
      <Link
        href={href}
        data-testid="auto-refresh-toggle"
        data-enabled={enabled ? "true" : "false"}
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
      >
        {enabled ? (
          <>
            <Pause className="size-4" />
            Pause auto-refresh
          </>
        ) : (
          <>
            <Play className="size-4" />
            Auto-refresh every 10s
          </>
        )}
      </Link>
    </div>
  );
}
