// Transcript-derived signals for the audit TRIAGE. These MIRROR the logic in
// src/lib/calls/classify-outcome.ts so triage flags calls the same way the
// post-call webhook classifies them. REVIEW AID ONLY — every real relabel still
// goes through human-confirmed relabel.js, so an approximation here is safe.
// If classify-outcome.ts's regexes change, update these to match.

/** Answering-machine / voicemail / IVR greeting markers. Verbatim copy of
 *  MACHINE_GREETING_RE in classify-outcome.ts. */
const MACHINE_GREETING_RE =
  /\bleave (us |you |your |a )*(a )?(message|voicemail)\b|\bafter (the )?(tone|beep)\b|\bat the (tone|beep)\b|\byou(?:'ve| have)? reached\b|\bpress (one|two|three|[0-9*#])\b|\bfor [a-z ,'-]{1,40}press\b|\bafter[- ]hours\b|\b(we are|we're|currently) closed\b|\bour office is closed\b|\bun(?:able|available) to (take|answer)\b|\b(can(?:no|')t|cannot) (take|come to)\b|\bmissed your call\b|\bplease leave\b|\byour party'?s extension\b|\breturn your call\b|\bvoice ?mail\b|\bmailbox\b|\bif this is an emergency\b|\bplease (stay on the line|hold)\b|\bthank you for calling\b[\s\S]{0,60}\bpress\b/i;

/** Recorded / IVR / menu / voicemail reply markers (EN/ES/FR). Verbatim copy of
 *  MACHINE_REPLY_RE in classify-outcome.ts. */
const MACHINE_REPLY_RE =
  /invalid|try again|recogniz|press (one|two|three|four|five|six|seven|eight|nine|zero|\d)|\boption\b|\bqueue\b|\bhold\b|transfer you to (the )?(receptionist|voicemail|our|billing|extension)|leave (a |your |us )?(message|voicemail)|after the (tone|beep)|thank you for calling|website|www\.|\.com|\.ca\b|receptionist for|virtual|assistant|\bai\b|not available|unavailable|please (stay|hold|wait)|connect you|record your|mailbox|good ?bye|voicemail|this call (may|will) be recorded|quality (assurance|purposes)|deja(r|me|nos)? (un |tu )?mensaje|despu[eé]s del (tono|bip|se[nñ]al)|permane(ce|zca) en la l[ií]nea|buz[oó]n|correo de voz|no (puedo|puede|está|estamos|estoy) (disponible|hablar|atender)|en este momento|gracias por (llamar|comunicarse)|dijo:|laissez (un |votre )?message|apr[eè]s (la|le) (tonalit|bip)|bo[iî]te vocale|messagerie/i;

/** An AGENT turn offers to remove the lead from calling (agent-manufactured DNC,
 *  as opposed to the person asking to stop unprompted). */
const AGENT_OFFER_REMOVAL_RE =
  /\btake you off\b|\bremove you\b|\btake you out of\b|\boff (the|our|your) (list|calling list)\b|\bdo(?:-| )?not(?:-| )?call\b|\bstop calling you\b|\bwon'?t call you again\b|\bmake sure we don'?t call\b/i;

function normalizeTurns(transcript) {
  if (!Array.isArray(transcript)) return [];
  return transcript
    .filter((t) => t && typeof t === "object" && typeof t.message === "string")
    .map((t) => ({ role: String(t.role ?? ""), message: t.message }));
}

const alphaLen = (s) => s.replace(/[^a-z]/gi, "").length;
const wordCount = (s) => s.trim().split(/\s+/).filter(Boolean).length;

/** Count GENUINE human replies (mirror of classify-outcome.ts): a user turn that
 *  follows an agent turn, is short/conversational (<=12 words), and isn't
 *  recorded machine/IVR/voicemail text. Stays ~0 for machines, >=2 for a real
 *  back-and-forth. */
function genuineHumanReplyCount(transcript) {
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

/** True when an AGENT turn offers to remove the lead from calling. */
function agentOfferedRemoval(transcript) {
  return normalizeTurns(transcript).some(
    (t) =>
      (t.role === "agent" || t.role === "ai") &&
      AGENT_OFFER_REMOVAL_RE.test(t.message),
  );
}

module.exports = {
  normalizeTurns,
  genuineHumanReplyCount,
  agentOfferedRemoval,
  MACHINE_GREETING_RE,
  MACHINE_REPLY_RE,
  AGENT_OFFER_REMOVAL_RE,
};
