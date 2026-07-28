import { createClient } from "@supabase/supabase-js";

import { priceOpenAiTokens } from "@/lib/costs/rates";

import {
  MIN_LEAD_WORDS,
  buildNote,
  countLeadWords,
  parseKnown,
  parseStatus,
  type ModelNote,
} from "./summary-note";
import { openAiKey } from "./live";

/**
 * Rolling call-context generator (BUILD_PLAN §13, rewritten 2026-07-28 — see
 * docs/superpowers/specs/2026-07-28-call-summary-rewrite-design.md).
 *
 * After each connected call we regenerate, in ONE model pass over the call
 * TRANSCRIPT:
 *
 *   1. the rolling per-campaign note (lead_campaign_summaries.ai_summary) — a
 *      short "Status / Left off / Known — don't re-ask" note for whoever calls
 *      this business next, and
 *   2. this call's pickup note (calls.callback_notes), surfaced when the call
 *      scheduled a callback.
 *
 * The model's output is UNTRUSTED. Person-names are limited to first names that
 * are either already on the lead record or backed by a transcript quote we
 * verify ourselves — see summary-note.ts, which does the enforcing. A call the
 * lead barely spoke on is skipped entirely: the note is left alone and no model
 * call is made.
 *
 * Facts-only by design: it records what happened and lets the next caller
 * decide. Cost is priced from real token usage. Live whenever an OpenAI key is
 * configured; deterministic mock otherwise (tests never hit the network).
 */

/** The model that writes the note. gpt-5.4-mini is a reasoning model — we send
 *  neither temperature nor max_tokens (it only accepts the defaults), matching
 *  how the Call Reviewer calls it. Because output is not stabilisable that way,
 *  the name rules are enforced in code rather than by prompt wording. */
export const SUMMARY_MODEL =
  process.env.SUMMARY_MODEL?.trim() || "gpt-5.4-mini";

export async function mergeLeadSummary(input: {
  leadId: string;
  campaignId: string;
  /** The call whose pickup note we store on calls.callback_notes. Omit to only
   *  update the rolling per-campaign summary (e.g. unit tests). */
  callId?: string;
  /** Preferred source: the full call transcript as "Agent:/Lead:" text. */
  transcript?: string | null;
  /** Fallback source when we have no transcript (the terse per-call recap). */
  latestSummary?: string | null;
}): Promise<{
  newSummary: string | null;
  callbackNotes: string | null;
  cost: number;
  mode: "mock" | "live" | "skipped";
}> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !serviceKey) {
    return { newSummary: null, callbackNotes: null, cost: 0, mode: "mock" };
  }
  const supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const transcript = (input.transcript ?? "").trim();
  const latest = (input.latestSummary ?? "").trim();
  if (!transcript && !latest) {
    return { newSummary: null, callbackNotes: null, cost: 0, mode: "mock" };
  }

  // A call the LEAD barely spoke on has nothing to teach us. Leave the note
  // exactly as it was and spend nothing. Only applies when we actually have a
  // transcript — the terse-recap fallback has no speaker labels to count.
  if (transcript && countLeadWords(transcript) < MIN_LEAD_WORDS) {
    return { newSummary: null, callbackNotes: null, cost: 0, mode: "skipped" };
  }

  // The note so far, split back into the parts the prompt carries forward.
  const { data: existingRow } = await supabase
    .from("lead_campaign_summaries")
    .select("ai_summary")
    .eq("lead_id", input.leadId)
    .eq("campaign_id", input.campaignId)
    .maybeSingle();
  const existing = (existingRow?.ai_summary ?? "").trim();
  const previousStatus = parseStatus(existing);
  const previousKnown = parseKnown(existing);

  // The lead's REAL business name and the contact names we already hold. ASR
  // routinely mis-hears the company name on the call, so the note is anchored
  // to the lead record, never to whatever the transcript picked up.
  const { data: leadRow } = await supabase
    .from("leads")
    .select("company, owner_name, manager_name, employee_name")
    .eq("id", input.leadId)
    .maybeSingle();
  const company = (leadRow?.company ?? "").trim();
  const contacts = [
    leadRow?.owner_name,
    leadRow?.manager_name,
    leadRow?.employee_name,
  ]
    .map((c) => (c ?? "").trim())
    .filter(Boolean);

  const apiKey = openAiKey();
  let newSummary: string;
  let callbackNotes: string;
  let cost = 0;
  if (apiKey) {
    const result = await callOpenAi(apiKey, {
      previousStatus,
      previousKnown,
      transcript,
      latest,
      company,
      contacts,
    });
    const note = buildNote(
      result.note,
      { transcript, company, contacts },
      { previousStatus, previousKnown },
    );
    newSummary = note.text;
    callbackNotes = note.callbackNotes;
    cost = priceOpenAiTokens(
      result.promptTokens,
      result.completionTokens,
      SUMMARY_MODEL,
    );
  } else {
    newSummary = mockMerge(existing, latest || transcript);
    callbackNotes = "";
  }

  // The per-campaign row is authoritative — the next outbound call for this
  // campaign reads it back as {{last_call_summary}}.
  await supabase.from("lead_campaign_summaries").upsert(
    {
      lead_id: input.leadId,
      campaign_id: input.campaignId,
      ai_summary: newSummary,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "lead_id,campaign_id" },
  );

  // Store this call's pickup note so a scheduled callback can surface it as
  // {{last_callback_notes}}. Blank → null (nothing to pick up on this call).
  if (input.callId) {
    await supabase
      .from("calls")
      .update({ callback_notes: callbackNotes.trim() || null })
      .eq("id", input.callId);
  }

  return {
    newSummary,
    callbackNotes,
    cost,
    mode: apiKey ? "live" : "mock",
  };
}

/** Deterministic concatenation used in mock mode (no OpenAI key). Kept in the
 *  legacy "we know X / we last left off Y" shape so offline tests can assert
 *  the structure. Pruned to 200 words. */
export function mockMerge(existing: string, latest: string): string {
  const merged = existing
    ? `we know ${stripWeKnow(existing)} / we last left off ${strip(latest)}`
    : `we know ${strip(latest)} / we last left off ${strip(latest)}`;
  return clampWords(merged, 200);
}

function stripWeKnow(s: string): string {
  return s.replace(/^we know /i, "").replace(/ \/ we last left off .*/i, "");
}

function strip(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function clampWords(s: string, max: number): string {
  const words = s.split(/\s+/);
  if (words.length <= max) return s;
  return words.slice(0, max).join(" ") + "…";
}

/** System prompt. The name rule is stated here AND enforced in summary-note.ts;
 *  the prompt alone is not reliable enough to depend on.
 *
 *  Examples use <ANGLE_BRACKET> placeholders on purpose. An earlier draft whose
 *  example read "the owner is Nicole, she's usually in Wednesdays" made the
 *  model emit "Owner is usually in on Wednesdays" for a business whose
 *  transcript said tomorrow — it copied the example instead of reading the
 *  call. Never put a sample value in here. */
const SYSTEM_PROMPT = `You keep a short, factual running note about a business our team is cold-calling, for whoever calls them next.

NAMES — the rule you are most likely to get wrong. Phone transcription mishears names constantly, and the usual failure is ADOPTING a name nobody actually gave: mishearing a business's greeting and treating it as a person, or turning the company name into a person's name.

You may write a person's name in exactly two situations:
  1. It appears in the "Contacts on file" list you are given, or
  2. A speaker EXPLICITLY identified that person by name — patterns like "the owner is <NAME>", "you'd want to talk to <NAME>", "this is <NAME> speaking", "ask for <NAME>".

For case 2 you must supply the verbatim transcript line that states it, in "evidence". The line is checked against the real transcript; if it does not appear there word for word, the name is thrown away along with every line that mentions it.

Use FIRST NAMES only. Never write a surname.

Everything else is a ROLE, never a name: "the person who answered", "the front desk", "the owner", "a staff member". In particular:
  - A name you got from how they ANSWERED the phone is not an explicit identification. A greeting like "thanks for calling <SOMETHING>" names no person — that is the business name, probably misheard. Do not turn it into a person.
  - Never infer a person's name from the company name.
  - Our own caller's name is never recorded. Only people at the business.
  - The business is ALWAYS the name on file. Never repeat a business name heard on the call, not even to correct it.
When you cannot record the name, keep the useful FACT and drop the name: "the owner is <NAME>, she's usually in on <DAY>" becomes "Owner is usually in on <DAY>" with the real day.

The angle-bracket placeholders above illustrate a PATTERN. Never copy them, and never copy a day, time or detail out of them — every fact you write must come from the transcript you are given.

Every call is between OUR agent and the business. The agent's own pitch, questions and talking points are NOT the lead's views — record only what the LEAD said. Past tense, third person, plain English. Never quote the transcript in a bullet. Invent nothing. Don't tell the next caller what to do. When in doubt, leave it out.`;

/** Strict JSON output. `names` carries the evidence we verify in code. */
const SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "left_off", "known", "callback_notes", "names"],
  properties: {
    status: { type: "string" },
    left_off: { type: "string" },
    known: { type: "array", items: { type: "string" } },
    callback_notes: { type: "string" },
    names: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "evidence"],
        properties: {
          name: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
  },
};

type PromptArgs = {
  previousStatus: string;
  previousKnown: string[];
  transcript: string;
  latest: string;
  company: string;
  contacts: string[];
};

function buildUserPrompt(args: PromptArgs): string {
  const priorStatus = args.previousStatus
    ? `Where we stood: ${args.previousStatus}`
    : "This is the first call to this business.";
  const priorKnown =
    args.previousKnown.length > 0
      ? `Facts already recorded (these are the exact strings you must carry forward):\n${args.previousKnown
          .map((k) => `  ${k}`)
          .join("\n")}`
      : // Parenthesised and lowercase on purpose: phrased as a bullet ("No facts
        // recorded yet.") the model copies it back out as if it were a fact.
        "Facts already recorded: (none)";
  const source = args.transcript
    ? `Transcript of the call that just happened:\n${args.transcript}`
    : `Recap of the call that just happened:\n${args.latest}`;

  return `Business on file: "${args.company}".
Contacts on file: ${args.contacts.join(", ") || "NONE — you may not write any personal name at all."}

${priorStatus}
${priorKnown}

${source}

Return JSON:

"status" — at most 10 words for where we stand with this business overall, counting all calls so far. Examples of the SHAPE: "Gatekeeper — owner not reached yet", "Interested, callback booked", "Not interested", "Asked to be removed", "Never got past the front desk".

"left_off" — ONE short sentence naming a concrete thing waiting to be picked up: an agreed callback, permission to send something, a time they told us to try. If there is no such thing, return an empty string. "They weren't the owner" and "they hung up" are NOT pickup points — that belongs in status, so return empty.

"known" — bullets recording what the LEAD has told us, so the next caller never re-asks. Rules, in order of importance:
  - Copy every string under "Facts already recorded" through EXACTLY as written. Do not reword, merge, or reorder them.
  - Then add up to 5 new bullets for things the LEAD said on this call. Prioritise concrete operational facts over impressions: the booking/scheduling/CRM software they named, their hours, who handles new leads, the best time to reach the decision-maker, how they handle missed calls.
  - A bullet is at most 10 words, third person, plain English. Never a quote or a first-person sentence from the transcript.
  - NEVER write a bullet about what we failed to learn. Absence of information is not a fact. If this call taught us nothing, add nothing and return only the carried-forward bullets.
  - Never restate what "status" already says.
  - Never write a bullet that just repeats something in "Contacts on file" or the business name. We already have those. Record what the lead TOLD us.
  - Max 8 bullets; if you would exceed that, drop the oldest.

"callback_notes" — 1-2 sentences ONLY if this call left a concrete pickup point. Otherwise empty string.

"names" — one entry for every person-name you used anywhere above that is NOT in "Contacts on file". Each entry needs the name and, in "evidence", the transcript line that explicitly identified that person, copied word for word from the transcript above. Empty array if you used no such names. A name whose evidence does not match the transcript is deleted along with every line that mentions it, so do not guess.`;
}

/** Live mode: one gpt-5.4-mini pass returning the note parts plus the names it
 *  wants to use. Plain fetch (no SDK dependency for a single call). On any
 *  failure we return an empty note and charge nothing — buildNote then falls
 *  back to the previous status and facts, so an outage never wipes the note. */
async function callOpenAi(
  apiKey: string,
  args: PromptArgs,
): Promise<{
  note: ModelNote;
  promptTokens: number;
  completionTokens: number;
}> {
  const empty: ModelNote = {
    status: "",
    leftOff: "",
    known: [],
    callbackNotes: "",
    names: [],
  };
  const fallback = { note: empty, promptTokens: 0, completionTokens: 0 };

  let res: Response;
  try {
    res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: SUMMARY_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(args) },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "call_note",
            strict: true,
            schema: SUMMARY_SCHEMA,
          },
        },
      }),
    });
  } catch {
    return fallback;
  }
  if (!res.ok) return fallback;

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = data.choices?.[0]?.message?.content;
  const promptTokens = data.usage?.prompt_tokens ?? 0;
  const completionTokens = data.usage?.completion_tokens ?? 0;
  if (!content) return { ...fallback, promptTokens, completionTokens };

  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
    const note: ModelNote = {
      status: str(parsed.status),
      leftOff: str(parsed.left_off),
      known: Array.isArray(parsed.known)
        ? parsed.known.filter((k): k is string => typeof k === "string")
        : [],
      callbackNotes: str(parsed.callback_notes),
      names: Array.isArray(parsed.names)
        ? parsed.names
            .filter(
              (n): n is { name: string; evidence: string } =>
                !!n &&
                typeof n === "object" &&
                typeof (n as { name?: unknown }).name === "string" &&
                typeof (n as { evidence?: unknown }).evidence === "string",
            )
            .map((n) => ({ name: n.name, evidence: n.evidence }))
        : [],
    };
    return { note, promptTokens, completionTokens };
  } catch {
    return { ...fallback, promptTokens, completionTokens };
  }
}
