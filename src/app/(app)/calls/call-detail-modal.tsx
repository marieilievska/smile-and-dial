"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  CalendarClock,
  ExternalLink,
  Mic,
  PhoneIncoming,
  Phone as PhoneIcon,
  Save,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  getCallDetail,
  overrideCallOutcome,
  scheduleManualCallback,
  type CallDetail,
  type TranscriptTurn,
} from "@/lib/calls/actions";
import { OVERRIDABLE_OUTCOMES, outcomeLabel } from "@/lib/calls/outcomes";

function fmtDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function fmtDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function fmtCost(breakdown: Record<string, unknown> | null): string {
  if (!breakdown) return "—";
  const total = breakdown.total;
  if (typeof total !== "number") return "—";
  return `$${total.toFixed(2)}`;
}

/**
 * Parse a transcript turn's start time. Tolerates both ISO date strings
 * (absolute timestamps) and numeric seconds (offsets from call start).
 * Returns null when nothing usable is present.
 */
function turnSeconds(
  turn: TranscriptTurn,
  callStartedAt: string | null,
): number | null {
  if (turn.started_at == null) return null;
  if (typeof turn.started_at === "number") return turn.started_at;
  const startMs = new Date(turn.started_at).getTime();
  if (!Number.isFinite(startMs)) return null;
  if (callStartedAt) {
    const base = new Date(callStartedAt).getTime();
    if (Number.isFinite(base)) return Math.max(0, (startMs - base) / 1000);
  }
  return null;
}

function fmtTurnTime(seconds: number | null): string {
  if (seconds == null) return "";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-foreground text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/**
 * Right-side slide-in modal opened via `?call=<id>`. Renders the audio
 * player, transcript (click a turn to seek), summary, extracted data,
 * score, cost, and a Jump to lead button.
 *
 * Read-only — outcome override + schedule callback land in Step 28b.
 */
export function CallDetailModal() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callId = searchParams.get("call");
  const [loaded, setLoaded] = useState<CallDetail | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Async fetch on callId change. Only calls setState inside the awaited
  // .then() (the react-hooks/set-state-in-effect rule allows this and
  // disallows synchronous setState in the body).
  useEffect(() => {
    if (!callId) return;
    let cancelled = false;
    getCallDetail(callId).then((result) => {
      if (cancelled) return;
      if (result.error) {
        toast.error(result.error);
      } else {
        setLoaded(result.call);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [callId]);

  // While we're fetching a new call (or the URL has no call param), avoid
  // showing the previous call's contents.
  const call = loaded && loaded.id === callId ? loaded : null;
  const loading = Boolean(callId) && !call;

  function close() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("call");
    const qs = params.toString();
    router.push(qs ? `/calls?${qs}` : "/calls");
  }

  function seekTo(seconds: number) {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = seconds;
    audio.play().catch(() => {
      // Autoplay can be blocked; user just has to press play. Not fatal.
    });
  }

  return (
    <Sheet
      open={Boolean(callId)}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <SheetContent className="flex w-full max-w-2xl flex-col gap-4 overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {call?.direction === "inbound" ? (
              <PhoneIncoming className="size-4" aria-label="Inbound" />
            ) : (
              <PhoneIcon className="size-4" aria-label="Outbound" />
            )}
            <span>{call?.leadCompany ?? "Call"}</span>
            {call?.outcome ? (
              <Badge variant="default" className="ml-1">
                {call.outcome}
              </Badge>
            ) : null}
          </SheetTitle>
          <SheetDescription>
            {call ? (
              <span className="font-mono text-xs">{call.leadPhone ?? "—"}</span>
            ) : loading ? (
              "Loading…"
            ) : (
              "Call not found."
            )}
          </SheetDescription>
        </SheetHeader>

        {call ? (
          <div className="flex flex-col gap-6 px-1">
            {/* Top metadata row */}
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <Metric label="Status" value={call.status} />
              <Metric
                label="Duration"
                value={fmtDuration(call.durationSeconds)}
              />
              <Metric
                label="Talk time"
                value={fmtDuration(call.talkTimeSeconds)}
              />
              <Metric
                label="Score"
                value={call.score == null ? "—" : call.score.toFixed(1)}
              />
              <Metric label="Campaign" value={call.campaignName} />
              <Metric label="Agent" value={call.agentName} />
              <Metric label="Started" value={fmtDateTime(call.startedAt)} />
              <Metric label="Cost" value={fmtCost(call.costBreakdown)} />
            </div>

            {/* Audio player */}
            {call.recordingPath ? (
              <Section title="Recording">
                <audio
                  ref={audioRef}
                  controls
                  preload="metadata"
                  className="w-full"
                  src={call.recordingPath}
                />
              </Section>
            ) : (
              <p className="text-muted-foreground flex items-center gap-2 text-sm">
                <Mic className="size-4" /> No recording for this call.
              </p>
            )}

            {/* Summary */}
            {call.summary ? (
              <Section title="Summary">
                <p className="text-muted-foreground text-sm whitespace-pre-line">
                  {call.summary}
                </p>
              </Section>
            ) : null}

            {/* Transcript */}
            {call.transcript.length > 0 ? (
              <Section title="Transcript">
                <ol className="border-border flex flex-col gap-1 rounded-lg border p-3">
                  {call.transcript.map((turn, i) => {
                    const seconds = turnSeconds(turn, call.startedAt);
                    const canSeek =
                      Boolean(call.recordingPath) && seconds != null;
                    return (
                      <li key={i} className="flex gap-3 py-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            if (canSeek) seekTo(seconds!);
                          }}
                          disabled={!canSeek}
                          className="text-muted-foreground hover:text-foreground disabled:text-muted-foreground/50 disabled:hover:text-muted-foreground/50 w-12 shrink-0 font-mono text-xs tabular-nums disabled:cursor-default"
                          aria-label={
                            canSeek
                              ? `Seek to ${fmtTurnTime(seconds)}`
                              : undefined
                          }
                        >
                          {fmtTurnTime(seconds)}
                        </button>
                        <div className="flex-1">
                          <p className="text-muted-foreground text-xs font-medium uppercase">
                            {turn.role ?? "—"}
                          </p>
                          <p className="text-foreground text-sm whitespace-pre-line">
                            {turn.text ?? ""}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </Section>
            ) : null}

            {/* Extracted data */}
            {call.extractedData &&
            Object.keys(call.extractedData).length > 0 ? (
              <Section title="Extracted data">
                <dl className="border-border grid grid-cols-1 gap-2 rounded-lg border p-3 text-sm sm:grid-cols-[max-content_1fr]">
                  {Object.entries(call.extractedData).map(([key, value]) => (
                    <div key={key} className="contents text-sm">
                      <dt className="text-muted-foreground font-medium uppercase">
                        {key.replace(/_/g, " ")}
                      </dt>
                      <dd className="text-foreground">
                        {typeof value === "string" ||
                        typeof value === "number" ||
                        typeof value === "boolean"
                          ? String(value)
                          : JSON.stringify(value)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </Section>
            ) : null}

            <Section title="Outcome">
              <OutcomeOverride
                callId={call.id}
                currentOutcome={call.outcome}
                onSaved={(next) => {
                  // Optimistically reflect the new outcome in the modal so
                  // the user sees the change without waiting for refetch.
                  setLoaded((prev) =>
                    prev && prev.id === call.id
                      ? { ...prev, outcome: next, outcomeSource: "manual" }
                      : prev,
                  );
                  router.refresh();
                }}
              />
            </Section>

            <div className="flex flex-wrap items-center gap-2">
              <ScheduleCallbackDialog callId={call.id} />
              {call.leadId ? (
                <Button asChild variant="outline">
                  <Link href={`/leads?lead=${call.leadId}`}>
                    <ExternalLink className="size-4" />
                    Open lead
                  </Link>
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-muted-foreground text-xs font-medium uppercase">
        {label}
      </span>
      <span className="text-foreground text-sm">{value}</span>
    </div>
  );
}

function OutcomeOverride({
  callId,
  currentOutcome,
  onSaved,
}: {
  callId: string;
  currentOutcome: string | null;
  onSaved: (next: string) => void;
}) {
  const [value, setValue] = useState(currentOutcome ?? "");
  const [pending, startTransition] = useTransition();
  const dirty = value !== "" && value !== (currentOutcome ?? "");

  function save() {
    if (!dirty) return;
    startTransition(async () => {
      const result = await overrideCallOutcome({ callId, outcome: value });
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Outcome updated.");
        onSaved(value);
      }
    });
  }

  return (
    <div className="flex items-end gap-2">
      <div className="flex-1">
        <Select value={value} onValueChange={setValue}>
          <SelectTrigger id="call-outcome-override" aria-label="Outcome">
            <SelectValue placeholder="Pick an outcome" />
          </SelectTrigger>
          <SelectContent>
            {OVERRIDABLE_OUTCOMES.map((o) => (
              <SelectItem key={o} value={o}>
                {outcomeLabel(o)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button onClick={save} disabled={!dirty || pending}>
        <Save className="size-4" />
        {pending ? "Saving…" : "Save outcome"}
      </Button>
    </div>
  );
}

function ScheduleCallbackDialog({ callId }: { callId: string }) {
  const [open, setOpen] = useState(false);
  const [when, setWhen] = useState("");
  const [pending, startTransition] = useTransition();

  function save() {
    if (!when) return;
    startTransition(async () => {
      const result = await scheduleManualCallback({
        callId,
        scheduledAt: new Date(when).toISOString(),
      });
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Callback scheduled.");
        setOpen(false);
        setWhen("");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <CalendarClock className="size-4" />
          Schedule callback
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Schedule a callback</DialogTitle>
          <DialogDescription>
            The dialer will redial this lead at the scheduled time, respecting
            the campaign&apos;s calling hours and pre-call checks.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="callback-when">When</Label>
          <Input
            id="callback-when"
            type="datetime-local"
            value={when}
            onChange={(event) => setWhen(event.target.value)}
            required
          />
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={!when || pending}>
            {pending ? "Scheduling…" : "Schedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
