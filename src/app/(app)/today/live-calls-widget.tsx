import { Headphones, PhoneOff } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ActiveCall } from "@/lib/today/queries";

const STATUS_LABEL: Record<ActiveCall["status"], string> = {
  queued: "Queued",
  dialing: "Dialing",
  ringing: "Ringing",
  in_progress: "On call",
};

const STATUS_VARIANT: Record<
  ActiveCall["status"],
  "default" | "secondary" | "outline"
> = {
  queued: "outline",
  dialing: "secondary",
  ringing: "secondary",
  in_progress: "default",
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

/** Card showing the AI agents currently making outbound calls. In mock
 *  mode this is usually empty since the mock dialer inserts calls
 *  straight to status='completed'; the card surfaces a friendly mock
 *  hint so the user isn't left wondering. */
export function LiveCallsWidget({
  rows,
  total,
  mockMode,
}: {
  rows: ActiveCall[];
  total: number;
  mockMode: boolean;
}) {
  const overflow = Math.max(0, total - rows.length);

  return (
    <section
      data-testid="live-calls-widget"
      className="border-border bg-card flex flex-col gap-3 rounded-lg border p-4"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-foreground text-sm font-semibold">
          Live calls
          {total > 0 ? (
            <span className="text-muted-foreground ml-2 font-normal">
              {total}
            </span>
          ) : null}
        </h2>
        {mockMode && rows.length === 0 ? (
          <Badge variant="secondary" className="text-[10px]">
            Mock data
          </Badge>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <div className="flex items-center gap-3 py-2">
          <PhoneOff className="text-muted-foreground size-5 shrink-0" />
          <div>
            <p className="text-foreground text-sm font-medium">
              No active calls.
            </p>
            <p className="text-muted-foreground text-xs">
              {mockMode
                ? "Mock dialer inserts calls as completed — flip TWILIO_LIVE / ELEVENLABS_LIVE to see live activity here."
                : "Active AI calls will appear here in real time."}
            </p>
          </div>
        </div>
      ) : (
        <>
          <ul className="flex flex-col gap-1.5">
            {rows.map((call) => (
              <li key={call.id}>
                <Link
                  href={`/calls?call=${call.id}`}
                  data-testid="live-call-row"
                  className="hover:bg-muted/60 flex items-center gap-3 rounded-md px-2 py-1.5 transition-colors"
                >
                  <Badge variant={STATUS_VARIANT[call.status]} dot>
                    {STATUS_LABEL[call.status]}
                  </Badge>
                  <span className="text-foreground flex-1 truncate text-sm">
                    {call.leadCompany ?? "Unknown lead"}
                    {call.campaignName ? (
                      <span className="text-muted-foreground">
                        {" · "}
                        {call.campaignName}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-muted-foreground font-mono text-xs tabular-nums">
                    {elapsed(call.started_at)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between gap-2">
            {overflow > 0 ? (
              <p className="text-muted-foreground text-xs">
                + {overflow} more active call{overflow === 1 ? "" : "s"}
              </p>
            ) : (
              <span />
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled
              title="Listening to live AI calls requires live Twilio + ElevenLabs mode."
            >
              <Headphones className="size-3" />
              Listen
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
