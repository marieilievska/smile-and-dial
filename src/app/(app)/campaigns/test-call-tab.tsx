"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, PhoneOff } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Browser-based test call from the campaign modal (BUILD_PLAN §17 line 1068).
 *
 * In live mode (ELEVENLABS_LIVE=live), this would open a WebSocket to
 * ElevenLabs Conversational AI's browser SDK so the user can talk to the
 * agent right there in the page. Spending real money on every test press
 * is a safety-rail concern, so the live wiring is deferred behind the env
 * flag — when this PR ships, calling Start runs the mock flow that walks
 * through the same UI states without actually connecting.
 *
 * The mock flow:
 *   idle → connecting (1s) → talking (with a canned transcript that
 *   appears line by line every ~2s) → ended (user hangs up or 12s timer).
 *
 * Tests assert against the state transitions and the visible transcript
 * so the UI scaffolding doesn't regress when the live integration lands.
 */

type CallState = "idle" | "connecting" | "talking" | "ended";

const MOCK_LINES: { role: "agent" | "user"; text: string }[] = [
  {
    role: "agent",
    text: "Hi, this is Sara calling from Referrizer — how are you today?",
  },
  { role: "user", text: "Doing well, what's this about?" },
  {
    role: "agent",
    text: "Quick question — are you the right person to talk to about your business's lead pipeline?",
  },
  { role: "user", text: "Yes, that's me." },
  {
    role: "agent",
    text: "Great. Would you have 15 minutes later this week for a quick walkthrough?",
  },
];

export function TestCallTab({ liveMode }: { liveMode: boolean }) {
  const [state, setState] = useState<CallState>("idle");
  const [transcript, setTranscript] = useState<typeof MOCK_LINES>([]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  function clearTimers() {
    timers.current.forEach((t) => clearTimeout(t));
    timers.current = [];
  }

  function start() {
    if (liveMode) {
      // Real ElevenLabs convai WebSocket wiring lives behind the live flag
      // and isn't implemented in this step. The Test tab is intentionally
      // a UI shell until you flip ELEVENLABS_LIVE off (mock) or implement
      // the convai client.
      return;
    }
    clearTimers();
    setTranscript([]);
    setState("connecting");
    timers.current.push(setTimeout(() => setState("talking"), 1000));
    // Reveal the canned transcript line by line.
    MOCK_LINES.forEach((line, i) => {
      timers.current.push(
        setTimeout(
          () => setTranscript((prev) => [...prev, line]),
          1000 + 1500 * (i + 1),
        ),
      );
    });
    // Auto-end after the last line.
    timers.current.push(
      setTimeout(
        () => setState("ended"),
        1000 + 1500 * (MOCK_LINES.length + 1),
      ),
    );
  }

  function hangUp() {
    clearTimers();
    setState("ended");
  }

  function reset() {
    clearTimers();
    setTranscript([]);
    setState("idle");
  }

  // Clean up timers when the tab unmounts.
  useEffect(() => {
    return () => clearTimers();
  }, []);

  if (liveMode) {
    return (
      <div className="flex flex-col gap-4">
        <div className="border-border bg-muted/30 flex flex-col gap-2 rounded-lg border p-4">
          <h4 className="text-foreground text-sm font-semibold">
            Live test call not implemented
          </h4>
          <p className="text-muted-foreground text-sm">
            ELEVENLABS_LIVE=live is set, but the browser-based test call wiring
            against ElevenLabs Conversational AI hasn&apos;t shipped yet — every
            press would attempt a paid connection. Unset the env var to use the
            mock flow, or wire up the convai SDK and remove this guard.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">
        Talk to this campaign&apos;s agent right here. Mock mode simulates the
        conversation flow without spending ElevenLabs credits.
      </p>

      <div className="border-border flex items-center justify-between gap-3 rounded-lg border px-4 py-3">
        <div className="flex items-center gap-2">
          {state === "talking" ? (
            <Mic className="text-success size-4" aria-label="On call" />
          ) : (
            <MicOff
              className="text-muted-foreground size-4"
              aria-label="Idle"
            />
          )}
          <span
            className="text-foreground text-sm font-medium"
            aria-live="polite"
          >
            {state === "idle" && "Ready to start"}
            {state === "connecting" && "Connecting…"}
            {state === "talking" && "On call (mock)"}
            {state === "ended" && "Call ended"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {state === "idle" || state === "ended" ? (
            <Button
              onClick={state === "ended" ? reset : start}
              variant="outline"
            >
              {state === "ended" ? "Start new test" : "Start test call"}
            </Button>
          ) : (
            <Button onClick={hangUp} variant="outline">
              <PhoneOff className="size-4" />
              Hang up
            </Button>
          )}
        </div>
      </div>

      {transcript.length > 0 ? (
        <ol
          className="border-border flex flex-col gap-2 rounded-lg border p-3"
          aria-label="Test call transcript"
        >
          {transcript.map((line, i) => (
            <li key={i} className="flex gap-3">
              <span className="text-muted-foreground w-12 shrink-0 text-xs font-medium uppercase">
                {line.role}
              </span>
              <span className="text-foreground text-sm">{line.text}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
