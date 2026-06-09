"use client";

import type { Call, Device as DeviceType } from "@twilio/voice-sdk";
import { Phone, PhoneOff, Mic, MicOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { dispositionHumanCall } from "@/lib/calls/human-disposition";

type Phase = "idle" | "connecting" | "in_call" | "ended" | "error";

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

  useEffect(() => {
    if (phase !== "in_call") return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const startCall = useCallback(async () => {
    setError(null);
    setMuted(false);
    setSeconds(0);
    setPhase("connecting");
    try {
      const res = await fetch("/api/twilio/voice-token", { method: "POST" });
      if (!res.ok) throw new Error("token");
      const { token } = (await res.json()) as { token: string };
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
    } catch {
      setError("Couldn't start the call. Check your mic permissions.");
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
  const options = [
    "goal_met",
    "callback",
    "not_interested",
    "no_answer",
    "voicemail",
    "dnc",
  ];
  async function save() {
    setSaving(true);
    setError(null);
    const result = await dispositionHumanCall({ leadId, outcome, note });
    setSaving(false);
    if (result?.error) {
      setError(result.error);
      return;
    }
    onDone();
  }
  return (
    <div className="border-border bg-card flex flex-col gap-2 rounded-lg border p-3">
      <p className="text-sm font-medium">How did the call go?</p>
      <select
        value={outcome}
        onChange={(e) => setOutcome(e.target.value)}
        className="border-border rounded-md border bg-transparent px-2 py-1 text-sm"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o.replace(/_/g, " ")}
          </option>
        ))}
      </select>
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note (optional)"
        className="border-border rounded-md border bg-transparent px-2 py-1 text-sm"
      />
      <Button size="sm" onClick={save} disabled={saving}>
        {saving ? "Saving…" : "Save outcome"}
      </Button>
      {error ? <p className="text-xs text-rose-600">{error}</p> : null}
    </div>
  );
}
