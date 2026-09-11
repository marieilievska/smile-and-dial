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
 *  as opposed to the person asking to stop unprompted). Widened 2026-09-11: the
 *  Daily HireAI Webinar agent (agent_2401…) says "if you want, I can make sure
 *  we don't bug you again", "would you want me to stop callin' this number",
 *  "if you do want me to stop reaching out, just let me know" — the old pattern
 *  caught 1 of the 10 offers made on 2026-09-10, and that one only through the
 *  agent's later "taken off the list" confirmation. This version flags exactly
 *  those 10 across all 2,206 calls that day. Apostrophes are ['’]: ElevenLabs
 *  writes the curly one. */
const AGENT_OFFER_REMOVAL_RE =
  /\bmake sure (we|this number|you|they|nobody|no one)\b[^.?!]{0,25}\b(don['’]?t|do not|doesn['’]?t|won['’]?t|never|stop)\b|\bstop (calling|callin['’]?|reaching out|contacting)\b|\b(want|like) me to (stop|take you|remove|make sure)\b|\bwon['’]?t (reach out|call|contact|bug|bother)\b[^.?!]{0,25}\bagain\b|\bwon['’]?t be (contacted|called)\b|\b(don['’]?t|not) (keep )?(bug|bugging|bother|bothering) you\b|\btake you off\b|\bremove you\b|\btake you out of\b|\boff (the|our|your) (list|calling list)\b|\bdo[-\s]?not[-\s]?call\b/i;

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

/** A LEAD turn that itself asks to stop / be removed (an unprompted request).
 *  Only used to ORDER turns (agent lines after this are confirmations), so it
 *  is deliberately BROADER than classify-outcome.ts's LEAD_REQUEST_REMOVAL_RE,
 *  which forces a DNC and must stay narrow. "erase our number from your
 *  Rolodex" (2026-09-10) is a real request the classifier doesn't match. */
const LEAD_REQUEST_REMOVAL_RE =
  /\b(take|get|leave)\s+(me|us|it|this|our|my)\b[^.?!]{0,40}\b(off|out)\b|\bremove\s+(me|us|it|this|our|my)\b|\berase\s+(me|us|it|this|our|my|the)\b|\bstop\s+call|\b(do not|don.?t|never)\s+(call|contact)|\bdo[- ]not[- ]call\b|\bunsubscribe\b/i;

/** True when an AGENT turn offers to remove the lead from calling BEFORE the
 *  lead asked for it themself. Agent turns after a lead-initiated request are
 *  confirmations ("got you taken off the list"), not offers — 2026-09-02
 *  calibration: that confirmation was the one false alarm of the day. */
function agentOfferedRemoval(transcript) {
  const turns = normalizeTurns(transcript);
  const firstLeadAsk = turns.findIndex(
    (t) => t.role !== "agent" && t.role !== "ai" && LEAD_REQUEST_REMOVAL_RE.test(t.message),
  );
  const scope = firstLeadAsk === -1 ? turns : turns.slice(0, firstLeadAsk);
  return scope.some(
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
  LEAD_REQUEST_REMOVAL_RE,
};
