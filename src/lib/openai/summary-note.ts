/**
 * Pure helpers for the rolling call note.
 * See docs/superpowers/specs/2026-07-28-call-summary-rewrite-design.md.
 *
 * Everything here is deterministic and side-effect free — no network, no DB.
 * The model's output is untrusted input: the prompt *asks* for the name rule,
 * this module is what *enforces* it. Prototyping showed the same prompt on the
 * same transcript emitting an unverified name on one run and not the next, so
 * nothing here may rely on the model having behaved.
 */

/** Minimum words the LEAD must speak before a call is worth summarising. Below
 *  this there is nothing to learn, so the note is left untouched and no model
 *  call is made. Measured over 61 production calls: skips 15% of them, and none
 *  whose outcome was callback / goal_met / not_interested / call_back_later. */
export const MIN_LEAD_WORDS = 15;

/** Maximum fact bullets a note carries. Oldest are dropped first. */
export const MAX_KNOWN_BULLETS = 8;

/** A person-name the model wants to record, with the transcript line it claims
 *  states it. The quote is verified against the real transcript. */
export type ClaimedName = { name: string; evidence: string };

export type NoteParts = {
  status: string;
  leftOff: string;
  known: string[];
  callbackNotes: string;
};

/** Exactly what the model returns, before any of it is trusted. */
export type ModelNote = NoteParts & { names: ClaimedName[] };

export type NameContext = {
  /** The call transcript as "Agent:/Lead:" text. */
  transcript: string;
  /** The business name from the lead record — never from the transcript. */
  company: string;
  /** Contact names already on the lead record (i.e. from the CSV). */
  contacts: string[];
};

export type ResolvedNames = {
  /** First-name tokens the note is allowed to mention, lower-cased. */
  allowed: Set<string>;
  /** Multi-word names to shorten wherever they appear, normalized. */
  shorten: { from: string; to: string }[];
  rejected: { name: string; reason: string }[];
};

/** Just the LEAD's half of an "Agent:/Lead:" transcript, speaker prefixes
 *  stripped. Everything the business said and nothing our agent said. */
export function leadSpeech(transcript: string): string {
  return (transcript ?? "")
    .split(/\r?\n/)
    .filter((line) => /^\s*lead:/i.test(line))
    .map((line) => line.replace(/^\s*lead:\s*/i, ""))
    .join(" ");
}

/** How many words the LEAD spoke, from the "Agent:/Lead:" transcript text that
 *  `transcriptToText` produces in the post-call webhook. */
export function countLeadWords(transcript: string): number {
  return leadSpeech(transcript).split(/\s+/).filter(Boolean).length;
}

/** Case-, punctuation- and whitespace-insensitive form used for all matching. */
export function normalizeForMatch(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Decide which person-names the note may mention.
 *
 * A name is allowed when it is already on the lead record, or when the model
 * supplies a transcript line that (a) really appears in what the LEAD said and
 * (b) actually contains the name. A name sharing a word with the business name
 * is rejected outright — that is the mishearing pattern ("Piggy", "Repz").
 * Only the FIRST name is ever allowed through.
 *
 * Evidence is matched against the LEAD's half of the transcript only. Our own
 * agent introduces itself by name on nearly every call ("my name's Jack"), and
 * that line is genuinely in the transcript — so matching the whole transcript
 * let the agent's own name through as a contact at the business. Only the
 * business can tell us who works there.
 */
export function resolveNames(
  claimed: ClaimedName[],
  ctx: NameContext,
): ResolvedNames {
  const haystack = normalizeForMatch(leadSpeech(ctx.transcript));
  const companyTokens = new Set(
    normalizeForMatch(ctx.company).split(" ").filter(Boolean),
  );
  const allowed = new Set<string>();
  const shorten: { from: string; to: string }[] = [];
  const rejected: { name: string; reason: string }[] = [];

  const accept = (normalized: string): void => {
    const parts = normalized.split(" ").filter(Boolean);
    if (parts.length === 0) return;
    allowed.add(parts[0]);
    if (parts.length > 1 && !shorten.some((s) => s.from === normalized)) {
      shorten.push({ from: normalized, to: parts[0] });
    }
  };

  // Names from the lead record need no evidence — the CSV is the source of truth.
  for (const contact of ctx.contacts) accept(normalizeForMatch(contact));
  const onFile = new Set(allowed);

  for (const { name, evidence } of claimed ?? []) {
    const normalized = normalizeForMatch(name);
    if (!normalized) continue;
    const first = normalized.split(" ")[0];
    // Same person as an on-file contact, possibly with a surname the CSV lacked.
    if (onFile.has(first)) {
      accept(normalized);
      continue;
    }
    // Drop any speaker prefix the model copied along with the line, so a quote
    // written as "Lead: …" still matches the prefix-stripped haystack.
    const quote = normalizeForMatch(
      evidence.replace(/^\s*(lead|agent|user|ai)\s*:\s*/i, ""),
    );
    if (!quote || !haystack.includes(quote)) {
      rejected.push({ name, reason: "quote not found in what the lead said" });
      continue;
    }
    if (!quote.includes(first)) {
      rejected.push({ name, reason: "quote does not contain the name" });
      continue;
    }
    if (normalized.split(" ").some((w) => companyTokens.has(w))) {
      rejected.push({ name, reason: "name is a word from the business name" });
      continue;
    }
    accept(normalized);
  }

  return { allowed, shorten, rejected };
}

/**
 * Capitalised words that are never a person's name in a call note. Any other
 * capitalised word gets its line dropped unless the name was verified, so this
 * list is what keeps real facts ("Wednesdays", "Vagaro") from being thrown out.
 *
 * Deliberately excludes words that are also common first names (Jane, May,
 * Bill): letting one through would allow an unverified name to survive, which
 * is the failure this whole module exists to prevent. Losing a booking-software
 * mention is the cheaper mistake.
 */
const NOT_NAMES = new Set(
  (
    "Monday Tuesday Wednesday Thursday Friday Saturday Sunday " +
    "Mondays Tuesdays Wednesdays Thursdays Fridays Saturdays Sundays " +
    "January February March April June July August September October November December " +
    "Morning Afternoon Evening Tonight Today Tomorrow Yesterday Weekday Weekend " +
    "They Their There The This That These Those Them She Her His Him " +
    "Owner Owners Manager Managers Staff Front Desk Receptionist Business Lead Agent " +
    "Call Calls Called Caller Callback Callbacks Phone Voicemail Voicemails " +
    "Open Opens Opened Close Closes Closed Closing Hours " +
    "After Before When While During Since Because Also Both Each Every Some Most Many " +
    "Not Never None Yes Maybe Hello Hi Thanks Thank Please Sure " +
    "First Second Third Next Last Another " +
    "Status Known Left Interested Gatekeeper Unclear Unknown " +
    "Ask Asked Try Tried Reach Reached Send Sent Said Says Told Mentioned Gave Fact Facts " +
    "Wants Needs Prefers Uses Used Handles Answers Answered Booked Booking Scheduled " +
    "Someone Somebody Nobody Everyone Person People Detail Details Best Better Good " +
    "Just Only Still Right Wrong Same Other Another New Old " +
    "AI CRM LLC Inc Spa Salon Studio Center Centre Clinic Wellness Beauty Hair Nails Med " +
    "Google Calendly Vagaro Mindbody Booksy Acuity Zenoti Phorest Fresha Schedulicity " +
    "Boulevard GlossGenius Setmore Square Yelp Facebook Instagram"
  )
    .split(/\s+/)
    .map((w) => w.toLowerCase()),
);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace each accepted multi-word name with just its first name, preserving
 *  the original capitalisation of the match. */
function shortenToFirstNames(
  line: string,
  shorten: { from: string; to: string }[],
): string {
  let out = line;
  for (const { from, to } of shorten) {
    // Tolerate whatever punctuation/whitespace sat between the name's words.
    const pattern = from.split(" ").map(escapeRegExp).join("[^A-Za-z]+");
    out = out.replace(new RegExp(pattern, "gi"), (match) =>
      /^[A-Z]/.test(match) ? to.charAt(0).toUpperCase() + to.slice(1) : to,
    );
  }
  return out;
}

/**
 * Shorten accepted names to first names, strip formatting noise, then drop the
 * whole line if it still mentions a name we could not verify.
 *
 * The line is dropped rather than the word excised: removing "Nicole" from
 * "The owner is Nicole and she is in tomorrow" leaves a sentence that still
 * asserts we know who the owner is. Losing a fact is recoverable; asserting a
 * false one is not.
 *
 * Returns "" for a dropped or empty line.
 */
export function applyNameRules(
  line: string,
  { allowed, shorten }: Pick<ResolvedNames, "allowed" | "shorten">,
): string {
  const out = shortenToFirstNames(line ?? "", shorten)
    .replace(/^[\s•\-–—*]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!out) return "";

  for (const word of out.split(/\s+/)) {
    const bare = word.replace(/[^A-Za-z'-]/g, "");
    if (!/^[A-Z][a-z']{2,}$/.test(bare)) continue;
    if (NOT_NAMES.has(bare.toLowerCase())) continue;
    if (allowed.has(bare.toLowerCase())) continue;
    return "";
  }
  return out;
}

/**
 * Phrases from OUR OWN prompt scaffolding that the model copies back as if they
 * were facts it learned. All three of these were observed against real
 * production transcripts:
 *   - "No facts recorded yet."  (the prompt's empty-state line)
 *   - "Contacts on file: owner Rhapsody, staff Paula"  (a prompt label)
 *   - "Owner Michelle" / "owner Trey"  (data we already hold, re-stated)
 *
 * The prompt forbids all of this. It does so unreliably — the same instruction
 * was obeyed on one run and ignored on the next — which is why it is enforced
 * here as well.
 */
const SCAFFOLD_ECHOES = new Set([
  "no facts recorded yet",
  "nothing recorded yet",
  "no facts yet",
  "nothing yet",
  "none",
  "this is the first call to this business",
  "first call to this business",
  "no prior calls",
  "not applicable",
  "n a",
]);

/** Prompt labels that must never open a fact bullet. */
const SCAFFOLD_PREFIXES = [
  "contacts on file",
  "business on file",
  "facts already recorded",
  "where we stood",
  "status",
  "left off",
  "known",
];

/** Words carrying no information on their own, used to decide whether a bullet
 *  says anything beyond naming a contact we already have. */
const FILLER_WORDS = new Set([
  "owner",
  "owners",
  "manager",
  "managers",
  "staff",
  "employee",
  "front",
  "desk",
  "receptionist",
  "contact",
  "contacts",
  "is",
  "was",
  "the",
  "a",
  "an",
  "our",
  "their",
  "on",
  "file",
]);

/**
 * True when a bullet carries no new information: our own scaffolding echoed
 * back, a prompt label, or a restatement of a contact/business name we already
 * hold. "Owner Michelle" is dropped; "Owner Michelle is in on Wednesdays" is
 * kept, because the rest of the sentence says something.
 */
function isNonFact(bullet: string, ctx: NameContext): boolean {
  const normalized = normalizeForMatch(bullet);
  if (!normalized) return true;
  if (SCAFFOLD_ECHOES.has(normalized)) return true;
  if (
    SCAFFOLD_PREFIXES.some(
      (p) => normalized === p || normalized.startsWith(`${p} `),
    )
  ) {
    return true;
  }
  const known = new Set([
    ...ctx.contacts.flatMap((c) => normalizeForMatch(c).split(" ")),
    ...normalizeForMatch(ctx.company).split(" "),
  ]);
  const remainder = normalized
    .split(" ")
    .filter((w) => w && !FILLER_WORDS.has(w) && !known.has(w));
  return remainder.length === 0;
}

/** The heading that introduces the fact bullets. Also the marker `parseKnown`
 *  looks for, so the two can never drift apart. */
const KNOWN_HEADING = "Known — don't re-ask:";

/** Lay the note out as the text stored in `lead_campaign_summaries.ai_summary`
 *  and shown, unchanged, to the next AI caller, the lead page and the closer. */
export function renderNote(parts: NoteParts): string {
  const lines: string[] = [];
  if (parts.status) lines.push(`Status: ${parts.status}`);
  if (parts.leftOff) lines.push(`Left off: ${parts.leftOff}`);
  if (parts.known.length > 0) {
    lines.push(KNOWN_HEADING);
    for (const bullet of parts.known) lines.push(`  • ${bullet}`);
  }
  return lines.join("\n");
}

/** Read the status line back out of a stored note. "" for a legacy prose note. */
export function parseStatus(note: string): string {
  const match = /^[ \t]*Status:[ \t]*(.+)$/m.exec(note ?? "");
  return match ? match[1].trim() : "";
}

/** Read the fact bullets back out of a stored note, so the next call can carry
 *  them forward verbatim. [] for a legacy prose note. */
export function parseKnown(note: string): string[] {
  const lines = (note ?? "").split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === KNOWN_HEADING);
  if (start === -1) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const match = /^\s*•\s*(.+)$/.exec(line);
    if (!match) break;
    out.push(match[1].trim());
  }
  return out;
}

/**
 * Turn one untrusted model response into the note we store.
 *
 * `previous` guards against the model wiping accumulated context: if it returns
 * no bullets at all, or its status line is dropped by the name rules, we keep
 * what we already had rather than persisting a regression.
 */
export function buildNote(
  model: ModelNote,
  ctx: NameContext,
  previous: { previousStatus: string; previousKnown: string[] },
): {
  text: string;
  callbackNotes: string;
  rejected: { name: string; reason: string }[];
} {
  const resolved = resolveNames(model.names, ctx);
  const clean = (value: string): string => applyNameRules(value, resolved);

  const known = (model.known ?? [])
    .map(clean)
    .filter(Boolean)
    .filter((bullet) => !isNonFact(bullet, ctx));
  const parts: NoteParts = {
    status: clean(model.status) || previous.previousStatus,
    leftOff: clean(model.leftOff),
    known: (known.length > 0 ? known : previous.previousKnown).slice(
      -MAX_KNOWN_BULLETS,
    ),
    callbackNotes: clean(model.callbackNotes),
  };

  return {
    text: renderNote(parts),
    callbackNotes: parts.callbackNotes,
    rejected: resolved.rejected,
  };
}
