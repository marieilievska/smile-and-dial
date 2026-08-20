import { NO_HUMAN_OUTCOMES } from "@/lib/calls/outcomes";
import type { Database } from "@/lib/supabase/database.types";

type CallOutcome = Database["public"]["Tables"]["calls"]["Row"]["outcome"];

/**
 * The disposition values our agents extract via ElevenLabs Data Collection.
 * These map 1:1 to a subset of our outcome enum (BUILD_PLAN §8 / §15).
 */
const DISPOSITION_TO_OUTCOME: Record<string, CallOutcome> = {
  gatekeeper: "gatekeeper",
  gatekeeper_not_interested: "gatekeeper_not_interested",
  not_interested: "not_interested",
  callback: "callback",
  // Retired 2026-08-11: "call back later" was the fuzziest disposition and its
  // fast-retry behaviour was marginal. A stray call_back_later from a not-yet-
  // resynced agent folds into gatekeeper (the normal retry cycle).
  call_back_later: "gatekeeper",
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

/** Split a resolved hang-up into immediate vs later by engagement + time.
 *  A hang-up is `hung_up_immediately` only when the person gave NO genuine reply
 *  AND the call was short (≤15s) — i.e. they hung up during/right after the
 *  greeting. Otherwise (they said something back, or stayed on the line past 15s)
 *  it's a `hung_up_later`: they engaged, then hung up. */
const IMMEDIATE_HANGUP_MAX_SECS = 15;
export function hangUpKind(
  callDurationSecs: number,
  humanReplies: number,
): "hung_up_immediately" | "hung_up_later" {
  const immediate =
    humanReplies === 0 && callDurationSecs <= IMMEDIATE_HANGUP_MAX_SECS;
  return immediate ? "hung_up_immediately" : "hung_up_later";
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
 *   3. SYSTEM / QUOTA ERROR — ElevenLabs killed the call itself ("exceeds your
 *      quota limit"): the AI failed mid-call, often on a live human who'd just
 *      said hello. That's an ai_error (our failure), NOT the lead hanging up.
 *   4. VOICEMAIL DETECTED (termination_reason) — ElevenLabs' voicemail_detection
 *      tool fired. Trust it UNLESS the transcript shows a genuine human
 *      conversation (a person answered, then the call tail hit a mailbox after a
 *      transfer): a late voicemail must NOT erase a human we reached. In that
 *      case use the agent's human disposition, else gatekeeper.
 *   5. DEAD AIR — the call ended because the other side went silent. Nobody
 *      hung up (EL ended it) and no real conversation happened, so even when the
 *      agent guessed disposition=hung_up this is a no-answer, not a hang-up.
 *   6. Otherwise the agent's disposition, else an unambiguous telephony state.
 *   7. IMMEDIATE HANG-UP — a sub-20s call the OTHER party ended (too short for a
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
  decisionMakerReached?: unknown;
}): { outcome: CallOutcome | null; reachedHuman: boolean } {
  const {
    transcript,
    disposition,
    terminationReason,
    callDurationSecs,
    decisionMakerReached,
  } = input;

  const dispositionOutcome = DISPOSITION_TO_OUTCOME[disposition] ?? null;
  const saysAi = calledPartySelfIdentifiesAsAi(transcript);
  const machineGreeting = transcriptLooksLikeMachine(transcript);
  const humanReplies = genuineHumanReplyCount(transcript);
  const vmByTermination = /voicemail/i.test(terminationReason);
  const silenceByTermination = /silence|no[ _-]?audio|no response/i.test(
    terminationReason,
  );
  // ElevenLabs killed the call for a platform/quota reason ("This request
  // exceeds your quota limit."). The agent errored; it isn't the lead's doing.
  const errorByTermination =
    /quota|exceeds your (quota|limit)|insufficient (credit|balance|quota)|credit limit|rate[- ]?limit/i.test(
      terminationReason,
    );
  const remotePartyEnded =
    /remote party|client|caller|\buser\b|hung ?up|hang ?up|disconnect/i.test(
      terminationReason,
    );
  // Dead air with no real conversation: EL ended on silence, and the agent's
  // best guess was a hang-up / voicemail / nothing (never a real human
  // disposition like not_interested, which we keep).
  const silenceAbandon =
    silenceByTermination &&
    humanReplies < 2 &&
    (dispositionOutcome == null ||
      dispositionOutcome === "hung_up_immediately" ||
      dispositionOutcome === "voicemail");

  let outcome: CallOutcome | null;
  if (saysAi) {
    outcome = "ai_receptionist";
  } else if (machineGreeting) {
    outcome = "voicemail";
  } else if (errorByTermination) {
    // ElevenLabs killed the call for a platform/quota reason. If a REAL two-way
    // human conversation already happened before the kill (≥2 genuine replies),
    // keep what the agent learned (its disposition + reachedHuman) rather than
    // erasing the summary/DM flag — mirrors the voicemail branch's guard. Only a
    // quota kill with no real conversation becomes ai_error.
    outcome =
      humanReplies >= 2 && dispositionOutcome ? dispositionOutcome : "ai_error";
  } else if (vmByTermination) {
    outcome =
      humanReplies >= 2
        ? dispositionOutcome && dispositionOutcome !== "voicemail"
          ? dispositionOutcome
          : "gatekeeper"
        : "voicemail";
  } else if (silenceAbandon) {
    outcome = "no_answer";
  } else {
    outcome = dispositionOutcome ?? telephonyOutcome(terminationReason);
  }

  // Immediate-hang-up correction: a sub-20s call the OTHER party ended has no
  // time for a real conversation. Never override a machine / AI / voicemail /
  // error / dead-air decision above — only a blank or a "gatekeeper" guess.
  const tooShortForRealTalk =
    remotePartyEnded && callDurationSecs > 0 && callDurationSecs <= 20;
  if (
    !saysAi &&
    !machineGreeting &&
    !errorByTermination &&
    !vmByTermination &&
    !silenceAbandon &&
    tooShortForRealTalk &&
    (outcome == null || outcome === "gatekeeper")
  ) {
    outcome = "hung_up_immediately";
  }

  // Split any resolved hang-up into immediate (no reply, hung up during the
  // greeting) vs later (engaged, or stayed on past 15s, then hung up). Covers
  // both the disposition=hung_up path and the short-call heuristic above.
  if (outcome === "hung_up_immediately") {
    outcome = hangUpKind(callDurationSecs, humanReplies);
  }

  // FINAL FALLBACK — classifyCallOutcome must NEVER return null. The post-call
  // webhook writes the outcome exactly once; a null here leaves a COMPLETED call
  // with a blank disposition forever (this is what stranded ~1,000 calls in Aug
  // 2026). We reach here only when the agent extracted NO disposition AND the
  // termination reason was not a telephony signal we map — the common case is
  // "Call ended by remote party" (the far end hung up), which is neither
  // voicemail, silence, busy, nor failure. Bucket by what actually happened:
  //   - a genuine two-way conversation (>=2 human replies) with no disposition →
  //     we reached a person but the agent never classified it: gatekeeper
  //     (reached-but-inconclusive), mirroring the vmByTermination branch above.
  //   - otherwise nobody really engaged → treat as a hang-up, split immediate vs
  //     later by the same duration/engagement rule used everywhere else.
  if (outcome == null) {
    outcome =
      humanReplies >= 2
        ? "gatekeeper"
        : hangUpKind(callDurationSecs, humanReplies);
  }

  // not_interested is DECISION-MAKER-only — which per the live disposition prompt
  // means "the owner, OR A MANAGER WHO CAN MAKE THE DECISION", not the owner alone.
  // Do not read this as owner-only: a manager with authority who firmly declines is
  // a legitimate not_interested, and auditors who apply an owner-only rule end up
  // over-relabeling real owner/manager declines down to gatekeeper_not_interested.
  // The dividing line is authority, not job title — a receptionist, or a manager who
  // defers ("call corporate", "we go through the franchise"), is the gatekeeper case.
  //
  // It rests the lead 30d and implies decision_maker_reached (OUTCOME_IMPLIES_DM).
  // If the extractor itself reported it did NOT reach the decision maker
  // (decision_maker_reached "no"/"unknown"), authority was never established:
  // downgrade to a firm gatekeeper decline (15d rest, NOT DM-implying). Mirrors
  // OUTCOME_EXCLUDES_DM's veto of a stray dm="yes" on a gatekeeper. A MISSING value
  // is left alone — we act only on positive non-decision-maker evidence, and the
  // extractor always populates this for a real not_interested.
  const dm =
    typeof decisionMakerReached === "string"
      ? decisionMakerReached.trim().toLowerCase()
      : "";
  if (outcome === "not_interested" && dm !== "" && dm !== "yes") {
    outcome = "gatekeeper_not_interested";
  }

  // A real two-way human conversation? Not for a machine (voicemail /
  // ai_receptionist), a no-pickup, a failure, or a hang-up (immediate or later).
  const reachedHuman =
    outcome != null &&
    outcome !== "hung_up_immediately" &&
    outcome !== "hung_up_later" &&
    !NO_HUMAN_OUTCOMES.has(outcome);

  return { outcome, reachedHuman };
}
