"use client";

import { useEffect, useRef, useState } from "react";
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { Mic, MicOff, PhoneOff, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getTestCallSession } from "@/lib/campaigns/test-call";
import {
  renderOpeningInstruction,
  type OpeningSituation,
} from "@/lib/elevenlabs/opening-line";
import { etFormat } from "@/lib/time/eastern";

/**
 * Real browser test call against THIS campaign's actual ElevenLabs agent.
 *
 * On "Start", the server mints a short-lived signed URL for the campaign's
 * agent (its real prompt / voice / tools) and the ElevenLabs browser SDK opens
 * a live mic conversation right here. This spends real ElevenLabs credits, like
 * any other call.
 */

type Line = { role: "agent" | "user"; text: string };

/** Which real call situation a browser test pretends to be. */
type TestAs = Exclude<OpeningSituation, "inbound">;

const TEST_AS_LABELS: Record<TestAs, string> = {
  cold: "First call (cold)",
  callback_booked: "Callback booked",
  spoken_before: "Spoken before",
};

/** Representative lead context so the agent's {{placeholders}} resolve during a
 *  test (there's no real lead behind a test call). The opener is the exact
 *  instruction a real call of the chosen kind gets, with "yesterday" as the
 *  timing. */
function testDynamicVariables(
  testAs: TestAs,
  openers: { callbackOpener: string | null; spokenBeforeOpener: string | null },
): Record<string, string> {
  // Eastern, matching the current_date the real dialer hands the agent.
  const today = etFormat(new Date(), {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return {
    call_type: testAs === "callback_booked" ? "callback" : "cold",
    opening_instruction: renderOpeningInstruction({
      situation: testAs,
      template:
        testAs === "callback_booked"
          ? openers.callbackOpener
          : openers.spokenBeforeOpener,
      when: "yesterday",
    }),
    last_call_summary: "",
    last_callback_notes: "",
    transfer_number: "",
    owner_name: "Alex (test)",
    city: "Austin",
    category: "fitness studio",
    google_rating: "4.8",
    google_reviews: "120",
    call_id: "test",
    current_date: today,
    current_time: new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date()),
    lead_timezone: "America/Chicago",
  };
}

function TestCallInner({ campaignId }: { campaignId: string }) {
  const [transcript, setTranscript] = useState<Line[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [testAs, setTestAs] = useState<TestAs>("cold");
  const endRef = useRef<HTMLLIElement | null>(null);

  const convo = useConversation({
    onConnect: () => setError(null),
    onMessage: ({ message, source }) =>
      setTranscript((prev) => [
        ...prev,
        { role: source === "ai" ? "agent" : "user", text: message },
      ]),
    onError: (message) =>
      setError(message || "The call hit an error. Please try again."),
  });

  const status = convo.status; // disconnected | connecting | connected | error
  const onCall = status === "connected";
  const connecting = preparing || status === "connecting";

  // Keep the latest transcript line in view.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [transcript]);

  async function start() {
    setError(null);
    setTranscript([]);
    setPreparing(true);
    const session = await getTestCallSession(campaignId);
    setPreparing(false);
    if (session.signedUrl === null) {
      setError(session.error);
      return;
    }
    try {
      convo.startSession({
        signedUrl: session.signedUrl,
        dynamicVariables: testDynamicVariables(testAs, {
          callbackOpener: session.callbackOpener,
          spokenBeforeOpener: session.spokenBeforeOpener,
        }),
      });
    } catch {
      setError(
        "Couldn't start the call — make sure your browser microphone is allowed.",
      );
    }
  }

  function hangUp() {
    convo.endSession();
  }

  // End the session if the tab unmounts mid-call so we don't leave it running.
  useEffect(() => {
    return () => {
      convo.endSession();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">
        Talk to this campaign&apos;s real agent right here — its actual prompt,
        voice, and tools. Uses your microphone and spends ElevenLabs credits,
        just like a live call.
      </p>

      <div className="flex flex-col gap-2">
        <Label htmlFor="test-call-as">Test as</Label>
        <Select
          value={testAs}
          onValueChange={(value) => setTestAs(value as TestAs)}
          disabled={onCall || connecting}
        >
          <SelectTrigger id="test-call-as" className="w-full sm:w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(TEST_AS_LABELS) as TestAs[]).map((key) => (
              <SelectItem key={key} value={key}>
                {TEST_AS_LABELS[key]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">
          Follow-up tests use this campaign&apos;s saved opener lines, with
          &ldquo;yesterday&rdquo; as the timing. Speak first, the way a business
          answers the phone.
        </p>
      </div>

      <div className="border-border flex items-center justify-between gap-3 rounded-lg border px-4 py-3">
        <div className="flex items-center gap-2">
          {onCall ? (
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
            {connecting
              ? "Connecting…"
              : onCall
                ? convo.isSpeaking
                  ? "Agent speaking…"
                  : "Listening…"
                : transcript.length > 0
                  ? "Call ended"
                  : "Ready to start"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {onCall ? (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => convo.setMuted(!convo.isMuted)}
              >
                {convo.isMuted ? (
                  <MicOff className="size-4" />
                ) : (
                  <Mic className="size-4" />
                )}
                {convo.isMuted ? "Unmute" : "Mute"}
              </Button>
              <Button type="button" variant="destructive" onClick={hangUp}>
                <PhoneOff className="size-4" />
                Hang up
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="outline"
              onClick={start}
              disabled={connecting}
            >
              {connecting ? <Loader2 className="size-4 animate-spin" /> : null}
              {transcript.length > 0 ? "Start new test" : "Start test call"}
            </Button>
          )}
        </div>
      </div>

      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      {transcript.length > 0 ? (
        <ol
          className="border-border flex max-h-72 flex-col gap-2 overflow-y-auto rounded-lg border p-3"
          aria-label="Test call transcript"
        >
          {transcript.map((line, i) => (
            <li
              key={i}
              className="flex gap-3"
              ref={i === transcript.length - 1 ? endRef : undefined}
            >
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

export function TestCallTab({ campaignId }: { campaignId: string }) {
  return (
    <ConversationProvider>
      <TestCallInner campaignId={campaignId} />
    </ConversationProvider>
  );
}
