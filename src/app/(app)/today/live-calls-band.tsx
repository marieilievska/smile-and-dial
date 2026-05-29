import { Headphones } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import type { ActiveCall } from "@/lib/today/queries";

const STATUS_LABEL: Record<ActiveCall["status"], string> = {
  queued: "Queued",
  dialing: "Dialing",
  ringing: "Ringing",
  in_progress: "On call",
};

function elapsed(startedAt: string | null): string {
  if (!startedAt) return "—";
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000),
  );
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Full-width "the AI is calling right now" band that anchors the Today
 *  page. Pulses while calls are live — the supervisor's heartbeat. */
export function LiveCallsBand({
  rows,
  total,
  mockMode,
}: {
  rows: ActiveCall[];
  total: number;
  mockMode: boolean;
}) {
  const idle = rows.length === 0;
  const overflow = Math.max(0, total - rows.length);

  // Idle → a quiet one-line strip. The page is calmest when nothing is
  // happening, so we collapse to a single row (dot + label + mock pill)
  // rather than a tall empty card. It expands to the full list the moment
  // a call goes live.
  if (idle) {
    return (
      <section
        data-testid="live-calls-band"
        data-state="idle"
        className="border-border bg-card animate-in fade-in slide-in-from-bottom-2 fill-mode-both flex items-center justify-between gap-3 rounded-xl border px-4 py-3 delay-75 duration-500"
      >
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="bg-muted-foreground/40 size-2.5 shrink-0 rounded-full"
          />
          <p className="text-muted-foreground text-sm">
            Idle — no AI calls in progress
          </p>
        </div>
        {mockMode ? (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium tracking-wider text-amber-800 uppercase dark:bg-amber-950 dark:text-amber-200">
            Mock data
          </span>
        ) : null}
      </section>
    );
  }

  return (
    <section
      data-testid="live-calls-band"
      data-state="active"
      style={{
        borderColor: "color-mix(in oklab, var(--primary) 35%, transparent)",
      }}
      className="border-border from-card via-card to-muted/30 animate-in fade-in slide-in-from-bottom-2 fill-mode-both relative overflow-hidden rounded-2xl border bg-gradient-to-br p-6 shadow-sm delay-75 duration-500"
    >
      {/* Header line — status + count */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span aria-hidden className="relative flex size-2.5 shrink-0">
            <span
              className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
              style={{ backgroundColor: "var(--primary)" }}
            />
            <span
              className="relative inline-flex size-2.5 rounded-full"
              style={{ backgroundColor: "var(--primary)" }}
            />
          </span>
          <p className="text-foreground text-base font-medium">
            {total} {total === 1 ? "call" : "calls"} in progress
          </p>
        </div>
        {mockMode ? (
          <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[10px] font-medium tracking-wider text-amber-800 uppercase dark:bg-amber-950 dark:text-amber-200">
            Mock data
          </span>
        ) : null}
      </div>

      {/* Live call list */}
      <ul className="mt-4 flex flex-col gap-1.5" data-testid="live-call-list">
        {rows.map((call) => (
          <li key={call.id}>
            <Link
              href={`/calls?call=${call.id}`}
              data-testid="live-call-row"
              className="hover:bg-background/60 group flex items-center gap-4 rounded-lg px-3 py-2 transition-colors"
            >
              {/* Per-call pulse dot, animates only when in_progress */}
              <span aria-hidden className="relative flex size-2 shrink-0">
                {call.status === "in_progress" ? (
                  <span
                    className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-70"
                    style={{ backgroundColor: "var(--primary)" }}
                  />
                ) : null}
                <span
                  className={
                    call.status === "in_progress"
                      ? "relative inline-flex size-2 rounded-full"
                      : "relative inline-flex size-2 rounded-full bg-amber-500"
                  }
                  style={
                    call.status === "in_progress"
                      ? { backgroundColor: "var(--primary)" }
                      : undefined
                  }
                />
              </span>
              <span className="text-muted-foreground w-16 shrink-0 text-xs tracking-wide uppercase">
                {STATUS_LABEL[call.status]}
              </span>
              <span className="text-foreground flex-1 truncate text-sm font-medium">
                {call.leadCompany ?? "Unknown lead"}
                {call.campaignName ? (
                  <span className="text-muted-foreground font-normal">
                    {" · "}
                    {call.campaignName}
                  </span>
                ) : null}
              </span>
              <span className="text-muted-foreground font-mono text-xs tabular-nums">
                {elapsed(call.started_at)}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled
                className="opacity-0 transition-opacity group-hover:opacity-100"
                title="Listening to live AI calls requires live Twilio + ElevenLabs mode."
              >
                <Headphones className="size-3" />
                Listen
              </Button>
            </Link>
          </li>
        ))}
        {overflow > 0 ? (
          <li>
            <p className="text-muted-foreground px-3 py-1 text-xs">
              + {overflow} more active call{overflow === 1 ? "" : "s"}
            </p>
          </li>
        ) : null}
      </ul>
    </section>
  );
}
