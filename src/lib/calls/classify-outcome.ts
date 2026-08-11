import { NO_HUMAN_OUTCOMES } from "@/lib/calls/outcomes";
import type { Database } from "@/lib/supabase/database.types";

type CallOutcome = Database["public"]["Tables"]["calls"]["Row"]["outcome"];

/**
 * The disposition values our agents extract via ElevenLabs Data Collection.
 * These map 1:1 to a subset of our outcome enum (BUILD_PLAN §8 / §15).
 */
const DISPOSITION_TO_OUTCOME: Record<string, CallOutcome> = {
  gatekeeper: "gatekeeper",
  not_interested: "not_interested",
  callback: "callback",
  call_back_later: "call_back_later",
  hung_up: "hung_up_immediately",
  dnc: "dnc",
  goal_met: "goal_met",
  voicemail: "voicemail",
};

/** Tell-tale phrases of an answering machine, voicemail, or IVR auto-attendant
 *  greeting. Deliberately specific so a live receptionist ("thanks for calling,
 *  how can I help?") never matches — only recorded systems say things like
 *  "leave a message", "after the tone", "press 1", or "you've reached us". */
const MACHINE_GREETING_RE =
  /\bleave (us |you |your |a )*(a )?(message|voicemail)\b|\bafter (the )?(tone|beep)\b|\bat the (tone|beep)\b|\byou(?:'ve| have)? reached\b|\bpress (one|two|three|[0-9*#])\b|\bfor [a-z ,'-]{1,40}press\b|\bafter[- ]hours\b|\b(we are|we're|currently) closed\b|\bour office is closed\b|\bun(?:able|available) to (take|answer)\b|\b(can(?:no|')t|cannot) (take|come to)\b|\bmissed your call\b|\bplease leave\b|\byour party'?s extension\b|\breturn your call\b|\bvoice ?mail\b|\bmailbox\b|\bif this is an emergency\b|\bplease (stay on the line|hold)\b|\bthank you for calling\b[\s\S]{0,60}\bpress\b/i;

/** The called party explicitly self-identifies as an AI / automated / virtual
 *  receptionist or assistant. When a bot answers and says so, the call reached a
 *  machine, not a person and not a mailbox — its own outcome (ai_receptionist).
 *  Matched against the CALLED party's turns only. */
const AI_SELF_ID_RE =
  /\bai receptionist\b|\bautomated receptionist\b|\bvirtual receptionist\b|\bai (assistant|agent)\b|\bsmart ai\b|\bi'?m an ai\b|\bi am (your |an |a )?ai\b|\bthis is \w+,? (a |an )?(smart )?ai\b|\bautomated (attendant|assistant)\b|\bvirtual assistant\b/i;

/** Phrases that mark a called-party turn as a RECORDING / IVR / menu / voicemail
 *  rather than a live human reply — multilingual (EN / ES / FR) because our
 *  leads include Spanish- and French-speaking businesses whose machines we must
 *  not mistake for people. Used to keep the "a real human replied" test honest:
 *  a turn matching this is machine text, never a genuine reply. */
const MACHINE_REPLY_RE =
  /invalid|try again|recogniz|press (one|two|three|four|five|six|seven|eight|nine|zero|\d)|\boption\b|\bqueue\b|\bhold\b|transfer you to (the )?(receptionist|voicemail|our|billing|extension)|leave (a |your |us )?(message|voicemail)|after the (tone|beep)|thank you for calling|website|www\.|\.com|\.ca\b|receptionist for|virtual|assistant|\bai\b|not available|unavailable|please (stay|hold|wait)|connect you|record your|mailbox|good ?bye|voicemail|this call (may|will) be recorded|quality (assurance|purposes)|deja(r|me|nos)? (un |tu )?mensaje|despu[eé]s del (tono|bip|se[nñ]al)|permane(ce|zca) en la l[ií]nea|buz[oó]n|correo de voz|no (puedo|puede|está|estamos|estoy) (disponible|hablar|atender)|en este momento|gracias por (llamar|comunicarse)|dijo:|laissez (un |votre )?message|apr[eè]s (la|le) (tonalit|bip)|bo[iî]te vocale|messagerie/i;

type Turn = { role?: unknown; message?: unknown };

function normalizeTurns(
  transcript: unknown,
): { role: string; message: string }[] {
  if (!Array.isArray(transcript)) return [];
  return transcript
    .filter(
      (t): t is Turn =>
        !!t && typeof t === "object" && typeof (t as Turn).message === "string",
    )
    .map((t) => ({ role: String(t.role ?? ""), message: t.message as string }));
}

const alphaLen = (s: string) => s.replace(/[^a-z]/gi, "").length;
const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** True when the called party never actually came on the line — the call hit a
 *  recorded greeting / answering machine and NO human replied. A machine-like
 *  opening (first caller turns read like a recording) is necessary but NOT
 *  sufficient: an IVR auto-attendant is a PHONE TREE that can route to a person.
 *  So we only call it a machine when, after the agent starts speaking, the called
 *  party gives no genuine reply (a `user` turn following an `agent` turn that
 *  isn't itself another machine line). */
export function transcriptLooksLikeMachine(transcript: unknown): boolean {
  const turns = normalizeTurns(transcript);
  const userMsgs = turns
    .filter((t) => t.role === "user")
    .map((t) => t.message.trim())
    .filter((m) => m.length > 0);
  if (userMsgs.length === 0) return false;
  const opening = userMsgs.slice(0, 2).join("  ");
  if (!MACHINE_GREETING_RE.test(opening)) return false;
  let agentSpoke = false;
  for (const t of turns) {
    if (t.role === "agent" || t.role === "ai") {
      agentSpoke = true;
      continue;
    }
    if (t.role === "user" && agentSpoke) {
      const m = t.message.trim();
      if (m.length > 0 && !MACHINE_GREETING_RE.test(m)) return false;
    }
  }
  return true;
}

/** The called party's turns self-identify as an AI/automated/virtual assistant. */
export function calledPartySelfIdentifiesAsAi(transcript: unknown): boolean {
  const userText = normalizeTurns(transcript)
    .filter((t) => t.role === "user")
    .map((t) => t.message)
    .join(" \n ");
  return AI_SELF_ID_RE.test(userText);
}

/** Count GENUINE human replies: a called-party turn that (a) follows an agent
 *  turn (real turn-taking), (b) is short and conversational (≤12 words), and
 *  (c) is not recorded machine / IVR / voicemail text in any of our languages.
 *  A recorded greeting or IVR — even one whose lines dodge MACHINE_GREETING_RE —
 *  produces long, repeated blurbs that fail the length/marker checks, so this
 *  stays ~0 for machines and ≥2 only for an actual back-and-forth with a person. */
export function genuineHumanReplyCount(transcript: unknown): number {
  const turns = normalizeTurns(transcript);
  let agentSpoke = false;
  let count = 0;
  for (const t of turns) {
    if (t.role === "agent" || t.role === "ai") {
      agentSpoke = true;
      continue;
    }
    if (t.role === "user" && agentSpoke) {
      const m = t.message.trim();
      if (
        alphaLen(m) >= 2 &&
        wordCount(m) <= 12 &&
        !MACHINE_GREETING_RE.test(m) &&
        !MACHINE_REPLY_RE.test(m)
      ) {
        count++;
      }
    }
  }
  return count;
}

/** Did the called party ever say anything substantive at all? (Distinguishes a
 *  silent / dead-air call — where the only "user" turns are empty or "..." —
 *  from a real answering machine whose greeting was transcribed.) */
export function hasSubstantiveCalledPartySpeech(transcript: unknown): boolean {
  return normalizeTurns(transcript).some(
    (t) => t.role === "user" && alphaLen(t.message) >= 3,
  );
}

/** Map an ElevenLabs termination reason to an UNAMBIGUOUS telephony outcome.
 *  Only the clear-cut carrier/system states are inferred here; a conversational
 *  "remote party ended" is intentionally left to the agent's disposition. */
export function telephonyOutcome(reason: string): CallOutcome | null {
  const r = reason.toLowerCase();
  if (/voicemail/.test(r)) return "voicemail";
  if (/silence|no[ _-]?audio|no response|did not respond/.test(r))
    return "no_answer";
  if (/no[ _-]?answer|unanswered|not answered|timed? ?out|timeout|ring/.test(r))
    return "no_answer";
  if (/busy/.test(r)) return "busy";
  if (/fail|carrier|invalid number|rejected|\berror\b/.test(r)) return "failed";
  return null;
}

/**
 * Decide a call's outcome from the transcript + the agent's disposition guess +
 * ElevenLabs' termination reason. Priority (most reliable evidence first):
 *
 *   1. AI RECEPTIONIST — the called party says it's an AI/automated/virtual
 *      assistant. A bot answered: not a person, not a mailbox.
 *   2. CONFIRMED MACHINE GREETING — the opening reads like an answering machine
 *      and no human ever replied → voicemail.
 *   3. VOICEMAIL DETECTED (termination_reason) — ElevenLabs' voicemail_detection
 *      tool fired. Trust it UNLESS the transcript shows a genuine human
 *      conversation (a person answered, then the call tail hit a mailbox after a
 *      transfer): a late voicemail must NOT erase a human we reached. In that
 *      case use the agent's human disposition, else gatekeeper.
 *   4. DEAD AIR — the call ended on silence and the other end never said
 *      anything real. The analysis LLM tends to guess "voicemail", but there's
 *      no machine and no human here: it's a no-answer.
 *   5. Otherwise the agent's disposition, else an unambiguous telephony state.
 *   6. IMMEDIATE HANG-UP — a sub-20s call the OTHER party ended (too short for a
 *      real conversation) that would otherwise be blank/gatekeeper.
 *
 * Also returns `reachedHuman`: did a real two-way human conversation happen
 * (drives whether we mirror the AI's extracted judgment fields onto the lead).
 */
export function classifyCallOutcome(input: {
  transcript: unknown;
  disposition: string;
  terminationReason: string;
  callDurationSecs: number;
}): { outcome: CallOutcome | null; reachedHuman: boolean } {
  const { transcript, disposition, terminationReason, callDurationSecs } =
    input;

  const dispositionOutcome = DISPOSITION_TO_OUTCOME[disposition] ?? null;
  const saysAi = calledPartySelfIdentifiesAsAi(transcript);
  const machineGreeting = transcriptLooksLikeMachine(transcript);
  const humanReplies = genuineHumanReplyCount(transcript);
  const substantiveSpeech = hasSubstantiveCalledPartySpeech(transcript);
  const vmByTermination = /voicemail/i.test(terminationReason);
  const silenceByTermination = /silence|no[ _-]?audio|no response/i.test(
    terminationReason,
  );
  const remotePartyEnded =
    /remote party|client|caller|\buser\b|hung ?up|hang ?up|disconnect/i.test(
      terminationReason,
    );

  let outcome: CallOutcome | null;
  if (saysAi) {
    outcome = "ai_receptionist";
  } else if (machineGreeting) {
    outcome = "voicemail";
  } else if (vmByTermination) {
    outcome =
      humanReplies >= 2
        ? dispositionOutcome && dispositionOutcome !== "voicemail"
          ? dispositionOutcome
          : "gatekeeper"
        : "voicemail";
  } else if (silenceByTermination && !substantiveSpeech && humanReplies === 0) {
    outcome = "no_answer";
  } else {
    outcome = dispositionOutcome ?? telephonyOutcome(terminationReason);
  }

  // Immediate-hang-up correction: a sub-20s call the OTHER party ended has no
  // time for a real conversation. Never override a machine / AI / voicemail /
  // dead-air decision above — only a blank or a "gatekeeper" guess.
  const tooShortForRealTalk =
    remotePartyEnded && callDurationSecs > 0 && callDurationSecs <= 20;
  if (
    !saysAi &&
    !machineGreeting &&
    !vmByTermination &&
    !silenceByTermination &&
    tooShortForRealTalk &&
    (outcome == null || outcome === "gatekeeper")
  ) {
    outcome = "hung_up_immediately";
  }

  // A real two-way human conversation? Not for a machine (voicemail /
  // ai_receptionist), a no-pickup, a failure, or an immediate hang-up.
  const reachedHuman =
    outcome != null &&
    outcome !== "hung_up_immediately" &&
    !NO_HUMAN_OUTCOMES.has(outcome);

  return { outcome, reachedHuman };
}
