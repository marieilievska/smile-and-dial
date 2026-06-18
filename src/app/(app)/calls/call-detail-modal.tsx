"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  CalendarClock,
  Check,
  Copy,
  Mic,
  PhoneCall,
  Save,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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
import { callStatusLabel } from "@/lib/labels";
import { exactDateTime, relativeTime } from "@/lib/relative-time";
import { Skeleton } from "@/components/ui/skeleton";

import {
  callStatusBadgeVariant,
  outcomeBadgeVariant,
  scoreTone,
} from "@/lib/outcome-style";

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

/** Plain-English explanation of why a call has no recording, keyed off
 *  the outcome. Used as the empty-state body when `recordingPath` is
 *  null — gives the reviewer something useful to read instead of just
 *  "No recording for this call." */
function noRecordingReason(outcome: string | null): string {
  switch (outcome) {
    case "voicemail":
      return "Voicemail — the AI left a message after the beep.";
    case "no_answer":
      return "No answer — the line rang out without anyone picking up.";
    case "busy":
      return "Busy signal — the line was occupied. The dialer will retry later.";
    case "failed":
      return "The call failed before connecting (carrier error or network drop).";
    case "hung_up_immediately":
      return "Picked up and hung up immediately — no conversation captured.";
    case "invalid_number":
      return "Twilio rejected the number as invalid.";
    case "gatekeeper":
      return "Reached a gatekeeper who didn't connect us to the decision maker.";
    case "language_barrier":
      return "Language barrier — the lead didn't speak the agent's language.";
    case "ai_error":
      return "The AI agent errored mid-call. Check the agent's logs.";
    case "call_back_later":
      return "Busy brush-off — they asked us to try another time. No real conversation captured.";
    case "callback":
      return "They asked for a callback. The conversation should appear above; if not, the recording wasn't returned.";
    case "not_interested":
      return "Spoke with someone who declined. The conversation should appear above.";
    case "ai_receptionist":
      return "Reached the business's own AI/auto-receptionist — no human conversation.";
    case "goal_met":
      return "Goal met. The conversation should appear above.";
    case "transferred_to_human":
      return "Transferred to a human rep. The conversation should appear above.";
    default:
      return "No conversation was captured for this call.";
  }
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

/** Title-case an extracted-data key. "next_action" → "Next action". */
function humanizeKey(key: string): string {
  const spaced = key.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/** Copy `text` to the clipboard and toast a confirmation. Returns true
 *  on success so the caller can flip its visual state. */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard.");
    return true;
  } catch {
    toast.error("Couldn't copy. Select the text and copy manually.");
    return false;
  }
}

function Section({
  title,
  trailing,
  children,
}: {
  title: string;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-foreground text-sm font-semibold">{title}</h3>
        {trailing}
      </div>
      {children}
    </section>
  );
}

/**
 * Right-side slide-in modal opened via `?call=<id>`. Renders the audio
 * player, transcript (click a turn to seek), summary, extracted data,
 * score, cost, and follow-up actions.
 *
 * v2 (round 6, M1-M15):
 * - Header is a stacked title block (no more badge colliding with X).
 * - Outcome pill uses the same palette as the calls list (success /
 *   coral / destructive / secondary), not a generic dark navy.
 * - "Status" metric is omitted for completed calls (the 95% case).
 * - "No recording" empty state is keyed off outcome and explains why.
 * - AI summary lives in a coral-accented card matching the lead detail.
 * - Metric grid splits into a hero row (duration / talk / cost / score)
 *   + a secondary row (campaign / agent / started).
 * - Transcript timestamps render as visible pill-buttons when the audio
 *   is seekable; muted plain text when there's no recording to seek.
 * - Extracted-data keys are humanized (no more SCREAMING UPPERCASE).
 * - Bottom action bar is sticky and includes Call again (coral, primary)
 *   alongside Schedule callback and Open lead.
 * - Outcome override is demoted below the actions — it's an admin
 *   correction tool, not the primary action.
 * - Copy buttons on the summary card and the transcript section.
 */
export function CallDetailModal() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Round 13 — the modal is now also mounted on /leads/<id>, so
  // closing must return to whatever page it was opened from, not a
  // hardcoded /calls.
  const pathname = usePathname();
  const callId = searchParams.get("call");
  const [loaded, setLoaded] = useState<CallDetail | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

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

  const call = loaded && loaded.id === callId ? loaded : null;
  const loading = Boolean(callId) && !call;

  function close() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("call");
    const qs = params.toString();
    // Stay on whatever page the modal was opened from (/calls,
    // /leads/<id>, /callbacks → "View original call", etc.). Fall
    // back to /calls if pathname isn't set (server-side render).
    const base = pathname || "/calls";
    // scroll: false — closing the modal must NOT jump the list back to the top;
    // the operator should land right where they were (same reason opening uses
    // scroll:false in call-row.tsx).
    router.push(qs ? `${base}?${qs}` : base, { scroll: false });
  }

  function seekTo(seconds: number) {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = seconds;
    audio.play().catch(() => {
      // Autoplay can be blocked; user just has to press play. Not fatal.
    });
  }

  function callAgain() {
    if (!call?.leadId) return;
    router.push(`/leads/${call.leadId}?action=call`);
  }

  // Talk ratio (M15) — what fraction of call time was actual speech.
  // Only meaningful if we have both numbers AND there was any talk.
  const talkRatio =
    call &&
    call.durationSeconds &&
    call.durationSeconds > 0 &&
    call.talkTimeSeconds != null
      ? Math.min(
          100,
          Math.round((call.talkTimeSeconds / call.durationSeconds) * 100),
        )
      : null;

  // The lifecycle status pill shows only while the call is LIVE, or as a
  // fallback when there's no outcome yet (e.g. a call that failed to place).
  // Once a call is terminal AND has an outcome, the outcome pill says it all —
  // so a failed call shows a single red "Failed", not a grey+red pair.
  const isLiveStatus =
    call != null &&
    ["queued", "dialing", "ringing", "in_progress"].includes(call.status);
  const showStatus = Boolean(
    call &&
    call.status &&
    (isLiveStatus || (!call.outcome && call.status !== "completed")),
  );

  return (
    <Sheet
      open={Boolean(callId)}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      {/* Round 7 — bumped max-width from 2xl (672px) to ~58vw with a
          generous floor so the hero metric row, transcript, and
          coral-bordered summary card all breathe. On smaller laptop
          screens the sheet still occupies a sensible majority of the
          viewport without overlapping the sidebar.
          Important: shadcn's <SheetContent> sets
          `data-[side=right]:sm:max-w-sm` by default, which beats a
          plain `sm:max-w-…` because of the data-attribute selector's
          specificity. Match it with the same selector to win. */}
      <SheetContent className="flex w-full flex-col gap-0 p-0 data-[side=right]:sm:max-w-[min(58vw,900px)]">
        {/* HEADER — stacked title cluster. Company on its own line so
            the outcome pill never collides with the close X. */}
        <SheetHeader className="border-border animate-in fade-in slide-in-from-top-1 border-b px-6 pt-6 pb-4 duration-300">
          <SheetTitle className="flex flex-col items-start gap-2 text-left">
            {/* Title is the lead deep-link: click → /leads/<id>,
                middle-click → new tab. Replaces the redundant
                "Open lead" footer button. */}
            {call?.leadId ? (
              <Link
                href={`/leads/${call.leadId}`}
                className="text-foreground hover:text-primary text-xl font-semibold underline-offset-2 hover:underline"
              >
                {call.leadCompany ?? "Untitled lead"}
              </Link>
            ) : (
              <span className="text-foreground text-xl font-semibold">
                {call?.leadCompany ?? (loading ? "Loading…" : "Call")}
              </span>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {call?.outcome ? (
                <Badge variant={outcomeBadgeVariant(call.outcome)}>
                  {outcomeLabel(call.outcome)}
                </Badge>
              ) : null}
              {showStatus ? (
                <Badge variant={callStatusBadgeVariant(call!.status)} dot>
                  {callStatusLabel(call!.status)}
                </Badge>
              ) : null}
            </div>
          </SheetTitle>
          <SheetDescription className="text-left" asChild>
            {call ? (
              <span className="font-mono text-xs">{call.leadPhone ?? "—"}</span>
            ) : loading ? (
              <Skeleton className="h-3.5 w-32" />
            ) : (
              <span>Call not found.</span>
            )}
          </SheetDescription>
        </SheetHeader>

        {/* SCROLLING BODY — every section lives here so the sticky
            footer below stays pinned regardless of transcript length. */}
        {call ? (
          <div className="animate-in fade-in flex-1 overflow-y-auto px-6 py-5 duration-300">
            <div className="flex flex-col gap-6">
              {/* M8 — Hero metric row: the four numbers an SDR actually
                  scans for. Tabular, larger type, equal weight. */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <HeroMetric
                  label="Duration"
                  value={fmtDuration(call.durationSeconds)}
                />
                <HeroMetric
                  label="Talk time"
                  value={fmtDuration(call.talkTimeSeconds)}
                  sub={talkRatio != null ? `${talkRatio}% of call` : undefined}
                />
                <HeroMetric label="Cost" value={fmtCost(call.costBreakdown)} />
                <HeroMetric
                  label="Score"
                  value={call.score == null ? "—" : call.score.toFixed(1)}
                  valueClassName={scoreTone(call.score)}
                />
              </div>

              {/* Secondary metadata — smaller, muted. */}
              <dl className="text-muted-foreground grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
                <SecondaryMetric label="Campaign" value={call.campaignName} />
                <SecondaryMetric label="Agent" value={call.agentName} />
                <SecondaryMetric
                  label="Started"
                  value={relativeTime(call.startedAt)}
                  title={exactDateTime(call.startedAt)}
                />
              </dl>

              {/* M4 — Recording (or a useful empty state). The audio src is
                  a short-lived signed URL minted server-side (recordingUrl),
                  not the raw storage path. */}
              {call.recordingUrl ? (
                <Section title="Recording">
                  <audio
                    ref={audioRef}
                    controls
                    preload="metadata"
                    className="w-full"
                    src={call.recordingUrl}
                  />
                </Section>
              ) : (
                <div className="border-border bg-muted/30 flex items-start gap-3 rounded-lg border p-3">
                  <Mic className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                  <p className="text-muted-foreground text-sm">
                    {noRecordingReason(call.outcome)}
                  </p>
                </div>
              )}

              {/* M7 — AI summary in a coral-accented card, matching
                  the elevated treatment on the lead detail page. */}
              {call.summary ? (
                <section
                  data-testid="call-ai-summary-block"
                  className="bg-card flex flex-col gap-3 rounded-xl border p-5"
                  style={{
                    borderColor:
                      "color-mix(in oklab, var(--primary) 25%, var(--border))",
                  }}
                >
                  <div className="flex items-center justify-between">
                    <h3 className="text-foreground inline-flex items-center gap-2 text-sm font-semibold">
                      <Sparkles
                        className="size-4"
                        style={{ color: "var(--primary)" }}
                      />
                      AI summary
                    </h3>
                    <CopyButton text={call.summary} label="Copy summary" />
                  </div>
                  <p className="text-foreground text-sm leading-relaxed whitespace-pre-line">
                    {call.summary}
                  </p>
                </section>
              ) : null}

              {/* M9 — Transcript with clickable timestamp pills. */}
              {call.transcript.length > 0 ? (
                <Section
                  title="Transcript"
                  trailing={
                    <CopyButton
                      text={call.transcript
                        .map((t) => `${t.role ?? "—"}: ${t.text ?? ""}`)
                        .join("\n")}
                      label="Copy transcript"
                    />
                  }
                >
                  {/* Conversation view — the AI's actual work product
                      should read like a chat, not a log. AI turns sit
                      left in a neutral bubble; the Lead's replies sit
                      right in a primary-tinted bubble. The seek
                      timestamp moves to the meta line above each bubble
                      and stays clickable when there's audio to scrub. */}
                  <ol
                    data-testid="call-transcript"
                    className="flex flex-col gap-3"
                  >
                    {call.transcript.map((turn, i) => {
                      const seconds = turnSeconds(turn, call.startedAt);
                      const canSeek =
                        Boolean(call.recordingUrl) && seconds != null;
                      const isLead = turn.role === "user";
                      const speaker =
                        turn.role === "agent"
                          ? "AI"
                          : isLead
                            ? "Lead"
                            : (turn.role ?? "—");
                      const timeLabel = fmtTurnTime(seconds);
                      return (
                        <li
                          key={i}
                          className={`flex flex-col gap-1 ${
                            isLead ? "items-end" : "items-start"
                          }`}
                        >
                          <div className="text-muted-foreground flex items-center gap-2 px-1 text-[11px] font-medium">
                            <span>{speaker}</span>
                            {timeLabel ? (
                              canSeek ? (
                                <button
                                  type="button"
                                  onClick={() => seekTo(seconds!)}
                                  className="hover:text-primary font-mono tabular-nums underline-offset-2 transition-colors hover:underline"
                                  aria-label={`Seek to ${timeLabel}`}
                                >
                                  {timeLabel}
                                </button>
                              ) : (
                                <span className="font-mono tabular-nums">
                                  {timeLabel}
                                </span>
                              )
                            ) : null}
                          </div>
                          <div
                            className={`text-foreground max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed whitespace-pre-line ${
                              isLead
                                ? "rounded-tr-sm"
                                : "bg-muted rounded-tl-sm"
                            }`}
                            style={
                              isLead
                                ? {
                                    backgroundColor:
                                      "color-mix(in oklab, var(--primary) 12%, var(--card))",
                                  }
                                : undefined
                            }
                          >
                            {turn.text ?? ""}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                </Section>
              ) : null}

              {/* M13 — Extracted data with sentence-case keys. */}
              {call.extractedData &&
              Object.keys(call.extractedData).length > 0 ? (
                <Section title="Extracted data">
                  <dl className="border-border grid grid-cols-1 gap-x-4 gap-y-2 rounded-lg border p-3 text-sm sm:grid-cols-[max-content_1fr]">
                    {Object.entries(call.extractedData).map(([key, value]) => (
                      <div key={key} className="contents text-sm">
                        <dt className="text-muted-foreground font-medium">
                          {humanizeKey(key)}
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

              {/* M5 — Outcome override demoted below the primary actions.
                  Admin correction tool, not the main thing you're here for. */}
              <details className="border-border bg-muted/30 group rounded-lg border p-3 text-sm">
                <summary className="text-foreground flex cursor-pointer items-center justify-between font-medium">
                  <span>Override outcome</span>
                  <span className="text-muted-foreground text-xs group-open:hidden">
                    Admin
                  </span>
                </summary>
                <div className="mt-3">
                  <OutcomeOverride
                    callId={call.id}
                    currentOutcome={call.outcome}
                    onSaved={(next) => {
                      setLoaded((prev) =>
                        prev && prev.id === call.id
                          ? { ...prev, outcome: next, outcomeSource: "manual" }
                          : prev,
                      );
                      router.refresh();
                    }}
                  />
                </div>
              </details>
            </div>
          </div>
        ) : loading ? (
          <CallDetailSkeleton />
        ) : (
          <div className="text-muted-foreground flex flex-1 items-center justify-center px-6 text-sm">
            Call not found.
          </div>
        )}

        {/* Sticky bottom action bar. Open lead is gone — the title is
            the lead deep-link, so a second "Open lead" button was just
            duplication. Schedule callback + Call again carry their
            own weight. */}
        {call ? (
          <div className="border-border bg-card flex flex-wrap items-center justify-end gap-2 border-t px-6 py-4">
            <ScheduleCallbackDialog callId={call.id} />
            {call.leadId ? (
              <Button
                onClick={callAgain}
                className="bg-primary hover:bg-primary/90 text-white"
              >
                <PhoneCall className="size-4" />
                Call again
              </Button>
            ) : null}
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/** Shaped placeholder shown while the call detail is fetched client-
 *  side. Mirrors the real body layout (hero metric row → secondary
 *  meta → recording → summary → transcript bubbles) so the panel
 *  doesn't jump when the data lands — feels instant instead of
 *  flashing a centered "Loading…". */
function CallDetailSkeleton() {
  return (
    <div
      data-testid="call-detail-skeleton"
      className="animate-in fade-in flex-1 overflow-y-auto px-6 py-5 duration-300"
    >
      <div className="flex flex-col gap-6">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <Skeleton className="h-2.5 w-12" />
              <Skeleton className="h-5 w-16" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <Skeleton className="h-2 w-10" />
              <Skeleton className="h-3 w-20" />
            </div>
          ))}
        </div>
        <Skeleton className="h-12 w-full rounded-lg" />
        <Skeleton className="h-28 w-full rounded-xl" />
        <div className="flex flex-col gap-3">
          <Skeleton className="h-12 w-3/5 self-start rounded-2xl" />
          <Skeleton className="h-10 w-1/2 self-end rounded-2xl" />
          <Skeleton className="h-14 w-2/3 self-start rounded-2xl" />
        </div>
      </div>
    </div>
  );
}

function HeroMetric({
  label,
  value,
  sub,
  valueClassName,
}: {
  label: string;
  value: string;
  sub?: string;
  /** Override the value color — used to tone the Score metric
   *  (emerald / amber / rose) so a good call reads at a glance. */
  valueClassName?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-muted-foreground text-[10px] font-medium tracking-[0.1em] uppercase">
        {label}
      </span>
      <span
        className={`text-xl font-semibold tabular-nums ${valueClassName ?? "text-foreground"}`}
      >
        {value}
      </span>
      {sub ? (
        <span className="text-muted-foreground text-[11px]">{sub}</span>
      ) : null}
    </div>
  );
}

function SecondaryMetric({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  title?: string;
}) {
  return (
    <div className="flex flex-col">
      <dt className="text-muted-foreground text-[10px] font-medium tracking-[0.08em] uppercase">
        {label}
      </dt>
      <dd
        className="text-foreground truncate text-xs"
        title={title || undefined}
      >
        {value}
      </dd>
    </div>
  );
}

/** Tiny ghost button that flips to a check icon for ~1.5s after a
 *  successful copy. Used by the AI summary card and the Transcript
 *  section header. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function onClick() {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      onClick={onClick}
      className="h-7 px-2 text-xs"
      aria-label={label}
    >
      {copied ? (
        <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
      ) : (
        <Copy className="size-3.5" />
      )}
      {copied ? "Copied" : "Copy"}
    </Button>
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
      <Button onClick={save} disabled={!dirty || pending} variant="outline">
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
