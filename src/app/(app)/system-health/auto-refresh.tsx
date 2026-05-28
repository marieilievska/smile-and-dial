"use client";

import { Pause, Play, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

/** Auto-refresh control for /system-health. Round 22 — promoted from
 *  a small text-link below the filters to a button pair in the
 *  header. Pairs the URL-state toggle (?auto=1) with a manual
 *  "Refresh now" button so an admin investigating doesn't have to
 *  wait the full 10 seconds.
 *
 *  The auto-refresh state lives in the URL so the page can pick it
 *  up on the server render — keeps the SSR'd table fresh without
 *  burning a state mount on every tick. */
export function AutoRefresh({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  const [spinning, setSpinning] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(() => router.refresh(), 10_000);
    return () => clearInterval(interval);
  }, [enabled, router]);

  const next = new URLSearchParams(params.toString());
  next.set("auto", enabled ? "0" : "1");
  const href = `/system-health?${next.toString()}`;

  function refreshNow() {
    setSpinning(true);
    router.refresh();
    // The spinner stops on its own after a short tick — router.refresh
    // is synchronous from React's POV but the server response takes a
    // beat, so the user sees a brief animation regardless.
    setTimeout(() => setSpinning(false), 600);
  }

  return (
    <div className="inline-flex items-center gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={refreshNow}
        aria-label="Refresh events now"
      >
        <RefreshCw className={`size-3.5 ${spinning ? "animate-spin" : ""}`} />
        Refresh
      </Button>
      <Button asChild variant={enabled ? "default" : "outline"} size="sm">
        <Link
          href={href}
          data-testid="auto-refresh-toggle"
          data-enabled={enabled ? "true" : "false"}
          aria-label={
            enabled ? "Pause auto-refresh" : "Enable auto-refresh every 10s"
          }
        >
          {enabled ? (
            <>
              <Pause className="size-3.5" />
              Auto · 10s
            </>
          ) : (
            <>
              <Play className="size-3.5" />
              Auto-refresh
            </>
          )}
        </Link>
      </Button>
    </div>
  );
}
