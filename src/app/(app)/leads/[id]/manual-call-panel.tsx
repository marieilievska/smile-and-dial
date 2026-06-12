"use client";

import type { Call, Device as DeviceType } from "@twilio/voice-sdk";
import { Phone, PhoneOff, Mic, MicOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { dispositionHumanCall } from "@/lib/calls/human-disposition";
import { outcomeLabel } from "@/lib/calls/outcomes";

type Phase = "idle" | "connecting" | "in_call" | "ended" | "error";

/**
 * Outcome options suited to a human-made call.
 * Common ones first, then the less-frequent ones.
 */
const HUMAN_CALL_OUTCOMES = [
  "goal_met",
  "callback",
  "not_interested",
  "no_answer",
  "voicemail",
  "dnc",
  "call_back_later",
  "gatekeeper",
  "language_barrier",
] as const;

export function ManualCallPanel({
  leadId,
  userId,
}: {
  leadId: string;
  userId: string;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [muted, setMuted] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const deviceRef = useRef<DeviceType | null>(null);
  const callRef = useRef<Call | null>(null);

  // Timer while in call
  useEffect(() => {
    if (phase !== "in_call") return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  // IMPROVEMENT: Warn before tab close/reload while a call is active.
  // Only attaches during "connecting" and "in_call"; removed on cleanup.
  useEffect(() => {
    if (phase !== "connecting" && phase !== "in_call") return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [phase]);

  const startCall = useCallback(async () => {
    setError(null);
    setMuted(false);
    setSeconds(0);
    setPhase("connecting");
    try {
      // ── Step 1: fetch token ──────────────────────────────────────────────
      // Errors here map to configuration / transient-server problems.
      const res = await fetch("/api/twilio/voice-token", { method: "POST" });
      if (!res.ok) {
        if (res.status === 503) {
          // 503 = TWILIO_TWIML_APP_SID not configured (not-set-up case)
          setError(
            "Browser calling isn't set up yet. Ask an admin to finish the Twilio setup.",
          );
        } else {
          // Any other non-OK status (401, 500, …) — transient / unknown
          setError("Couldn't start the call — please try again.");
        }
        setPhase("error");
        return;
      }
      const { token } = (await res.json()) as { token: string };

      // ── Step 2: create Device and connect ───────────────────────────────
      // Errors here are typically mic-permission or Twilio SDK issues.
      try {
        const { Device } = await import("@twilio/voice-sdk");
        const device = new Device(token, { logLevel: "error" });
        deviceRef.current = device;
        const call = await device.connect({ params: { leadId, userId } });
        callRef.current = call;
        call.on("accept", () => {
          setSeconds(0);
          setPhase("in_call");
        });
        call.on("disconnect", () => setPhase("ended"));
        call.on("error", () => setPhase("error"));
      } catch (err) {
        // Inspect the error to distinguish mic-permission from everything else.
        // Browser getUserMedia rejections use: NotAllowedError, NotFoundError.
        // Twilio SDK audio-device errors carry similar names or messages.
        const name = (err as { name?: string })?.name ?? "";
        const message = (err as { message?: string })?.message ?? "";
        const isMicError =
          name === "NotAllowedError" ||
          name === "NotFoundError" ||
          /microphone|audio device|getUserMedia/i.test(message);

        if (isMicError) {
          setError(
            "Microphone access is blocked. Allow mic access in your browser and try again.",
          );
        } else {
          setError(
            "Something went wrong starting the call — please try again.",
          );
        }
        setPhase("error");
      }
    } catch {
      // Outer catch: network failure reaching the token endpoint, JSON parse
      // error, or any other unexpected throw before reaching the Device step.
      setError("Something went wrong starting the call — please try again.");
      setPhase("error");
    }
  }, [leadId, userId]);

  const hangUp = useCallback(() => {
    callRef.current?.disconnect();
    deviceRef.current?.destroy();
  }, []);

  const toggleMute = useCallback(() => {
    const call = callRef.current;
    if (!call) return;
    const next = !muted;
    call.mute(next);
    setMuted(next);
  }, [muted]);

  // Destroy the Device on panel unmount to free audio resources
  useEffect(() => () => deviceRef.current?.destroy(), []);

  const mmss = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

  if (phase === "ended") {
    return <DispositionForm leadId={leadId} onDone={() => setPhase("idle")} />;
  }

  if (phase === "idle" || phase === "error") {
    return (
      <div className="flex flex-col gap-1">
        <Button onClick={startCall} className="gap-2">
          <Phone className="size-4" />
          Call manually
        </Button>
        {error ? <p className="text-xs text-rose-600">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="border-border bg-card flex items-center gap-3 rounded-lg border p-3">
      <span className="relative flex size-2.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-70" />
        <span className="relative inline-flex size-2.5 rounded-full bg-emerald-500" />
      </span>
      <span className="text-sm font-medium tabular-nums">
        {phase === "connecting" ? "Connecting…" : mmss}
      </span>
      <div className="ml-auto flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={toggleMute}
          className="gap-1"
        >
          {muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
          {muted ? "Unmute" : "Mute"}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={hangUp}
          className="gap-1"
        >
          <PhoneOff className="size-4" />
          Hang up
        </Button>
      </div>
    </div>
  );
}

function DispositionForm({
  leadId,
  onDone,
}: {
  leadId: string;
  onDone: () => void;
}) {
  const [outcome, setOutcome] = useState("goal_met");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    const result = await dispositionHumanCall({ leadId, outcome, note });
    setSaving(false);
    // If the action returned an error, stay open and surface it.
    if (result?.error) {
      setError(result.error);
      return;
    }
    onDone();
  }

  return (
    <div className="border-border bg-card flex flex-col gap-3 rounded-lg border p-3">
      <div>
        <p className="text-sm font-medium">How did the call go?</p>
        <p className="text-muted-foreground mt-0.5 text-xs">
          Logging the outcome keeps the lead&apos;s pipeline and follow-ups
          accurate.
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="disposition-outcome" className="text-xs font-medium">
          Outcome
        </Label>
        <Select value={outcome} onValueChange={setOutcome}>
          <SelectTrigger id="disposition-outcome" className="w-full">
            <SelectValue placeholder="Select an outcome" />
          </SelectTrigger>
          <SelectContent>
            {HUMAN_CALL_OUTCOMES.map((o) => (
              <SelectItem key={o} value={o}>
                {outcomeLabel(o)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="disposition-note" className="text-xs font-medium">
          Note (optional)
        </Label>
        <input
          id="disposition-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Add a note…"
          className="border-border rounded-md border bg-transparent px-2 py-1 text-sm"
        />
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save outcome"}
        </Button>
        {/* Skip lets the user acknowledge the call happened without logging now */}
        <Button size="sm" variant="ghost" onClick={onDone} disabled={saving}>
          Skip for now
        </Button>
      </div>

      {error ? <p className="text-xs text-rose-600">{error}</p> : null}
    </div>
  );
}
