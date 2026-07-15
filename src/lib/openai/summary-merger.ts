import { createClient } from "@supabase/supabase-js";

import { priceOpenAiTokens } from "@/lib/costs/rates";

import { openAiKey } from "./live";

/**
 * Rolling call-context generator (BUILD_PLAN §13, reworked 2026-07-15).
 *
 * After each CONNECTED call we regenerate two things for the NEXT caller:
 *
 *   1. last_call_summary  — a rolling, factual running memory about this
 *      business for this campaign (lead_campaign_summaries.ai_summary). It
 *      leads with WHO we reached and their ROLE, who actually decides / handles
 *      leads, what the lead themselves said, and ends with an explicit
 *      "Already answered — don't re-ask:" list so the agent stops
 *      re-interrogating on the next call.
 *
 *   2. last_callback_notes — a short pickup note for THIS call (stored on
 *      calls.callback_notes), surfaced only when this call scheduled a
 *      callback: what was agreed and where we left off.
 *
 * Both are generated in ONE model pass from the call TRANSCRIPT (not the terse
 * ElevenLabs recap), so the role / decision-gateway / "anchor" detail actually
 * makes it into the note. Model is gpt-5.4-mini (same tier the Call Reviewer's
 * first pass uses), overridable via SUMMARY_MODEL.
 *
 * Facts-only by design: it records what happened and lets the agent decide what
 * to do — it never invents a sales strategy or a next-step. Cost is priced from
 * the real token usage via the central rates module. Live whenever an OpenAI key
 * is configured; deterministic mock otherwise (tests never hit the network).
 */

/** The model that writes the running note. gpt-5.4-mini is a reasoning model —
 *  we send neither temperature nor max_tokens (it only accepts the defaults),
 *  matching how the Call Reviewer calls it. */
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
  mode: "mock" | "live";
}> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !serviceKey) {
    return { newSummary: null, callbackNotes: null, cost: 0, mode: "mock" };
  }
  const supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Read the existing rolling note from the per-campaign row.
  const { data: existingRow } = await supabase
    .from("lead_campaign_summaries")
    .select("ai_summary")
    .eq("lead_id", input.leadId)
    .eq("campaign_id", input.campaignId)
    .maybeSingle();
  const existing = (existingRow?.ai_summary ?? "").trim();

  // The lead's REAL business name + any contact names we already hold. ASR
  // routinely mis-hears the company name on the call (e.g. "Evolve Thermal Spa"
  // heard as "Mangerie Bravo"), so we anchor the note to the lead record and
  // tell the model to use it, not whatever name the transcript picked up.
  const { data: leadRow } = await supabase
    .from("leads")
    .select("company, owner_name, manager_name, employee_name")
    .eq("id", input.leadId)
    .maybeSingle();
  const company = (leadRow?.company ?? "").trim();
  const contacts = [
    leadRow?.owner_name && `owner ${leadRow.owner_name}`,
    leadRow?.manager_name && `manager ${leadRow.manager_name}`,
    leadRow?.employee_name && `staff ${leadRow.employee_name}`,
  ]
    .filter(Boolean)
    .join(", ");

  // Prefer the transcript; fall back to the terse recap. Nothing to do without
  // either — bail without writing (matches the old no-op behaviour).
  const transcript = (input.transcript ?? "").trim();
  const latest = (input.latestSummary ?? "").trim();
  if (!transcript && !latest) {
    return { newSummary: null, callbackNotes: null, cost: 0, mode: "mock" };
  }

  const apiKey = openAiKey();
  const live = Boolean(apiKey);
  let newSummary: string;
  let callbackNotes: string;
  let cost = 0;
  if (apiKey) {
    const result = await callOpenAi(apiKey, {
      existing,
      transcript,
      latest,
      company,
      contacts,
    });
    newSummary = result.rollingSummary;
    callbackNotes = result.callbackNotes;
    cost = priceOpenAiTokens(result.promptTokens, result.completionTokens);
  } else {
    newSummary = mockMerge(existing, latest || transcript);
    callbackNotes = "";
  }

  // Upsert the per-campaign summary row. The per-campaign row is
  // authoritative — the next outbound call for this campaign reads it.
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

  return { newSummary, callbackNotes, cost, mode: live ? "live" : "mock" };
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

/** System prompt: attribution discipline + facts-only. Deliberately generic —
 *  no agent name is hard-coded, so it reads correctly for every agent. */
const SYSTEM_PROMPT =
  "You maintain a short, factual running memory about a business our team is " +
  "phoning, for whoever calls them next. Every call is between OUR agent and " +
  "the business (the lead). The agent's pitch, questions, and talking points " +
  "are NOT the lead's views — never write that the lead wants, likes, is " +
  "interested in, or agreed to something unless the LEAD clearly said so. If " +
  "the agent asked something the lead didn't answer, the lead's position is " +
  "still unknown — say so. Never invent names, roles, numbers, prices, or " +
  "claims that aren't in the transcript. Write in past tense (these calls " +
  "already happened). Do NOT tell the next caller what to do — record the " +
  "facts and let them decide. When in doubt, under-claim.";

/** Strict two-field JSON output. */
const SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["rolling_summary", "callback_notes"],
  properties: {
    rolling_summary: { type: "string" },
    callback_notes: { type: "string" },
  },
};

function buildUserPrompt(args: {
  existing: string;
  transcript: string;
  latest: string;
  company: string;
  contacts: string;
}): string {
  const companyLine = args.company
    ? `Business we're calling: "${args.company}". Use THIS name; if the transcript shows a different business name it was mis-heard on the call — ignore it and use "${args.company}".`
    : "";
  const contactsLine = args.contacts
    ? `Contacts already on file: ${args.contacts}.`
    : "";
  const source = args.transcript
    ? `Transcript of the latest call:\n${args.transcript}`
    : `Latest call recap:\n${args.latest}`;

  return `${companyLine}
${contactsLine}

Running memory so far (from earlier calls):
${args.existing || "(none yet)"}

${source}

Update the running memory and write a pickup note. Return JSON with two string fields:

"rolling_summary" — the factual running memory for whoever calls this business next. Capture, in past tense, ONLY what the transcript / known facts support:
- WHO we reached and their ROLE — owner / office manager / front desk / receptionist / unclear — named if given.
- The REAL decision-gateway: who actually decides, or who handles new leads, even when that's NOT the owner (e.g. "owner never on-site; front-desk manager Jane handles leads"). State reachability as facts — who we can and can't reach, and the best contact or email.
- What the LEAD actually said — their questions, objections, or stated interest/disinterest. If they didn't engage (put us on hold, hung up, went to voicemail, or we only reached a gatekeeper), say plainly what blocked us.
- The lead's own pain point ONLY if the LEAD raised it. Never guess one.
- A commitment ONLY if the lead explicitly agreed to one (a callback time, permission to send info). If none, say no commitment was made.
- Finish with a line starting "Already answered — don't re-ask:" listing everything the lead has already told us across all calls, so the next caller never re-interrogates them. Common items: how fast they follow up on new leads or missed calls (the "anchor" question our agent opens with), what scheduling / CRM software they use, whether the owner will take a call, and who handles leads. Omit this line only if nothing has been answered yet.

"callback_notes" — a SHORT pickup note (1–2 sentences) for the next caller, ONLY if this call left a concrete place to pick up: a promised callback, permission to send info, or "call back after 5 to reach the owner". Say what was agreed and where we left off, and remind not to re-ask what's already answered. If there is no concrete pickup point, return an empty string.

Do NOT invent details. Do NOT include dates or "X days ago" timing — the caller is told separately how long ago the last call was. No filler. Keep "rolling_summary" under ~180 words.`;
}

/** Live mode: one gpt-5.4-mini pass returning the updated running note + the
 *  per-call pickup note. Plain fetch (no SDK dependency for a single call). On
 *  any failure we fall back to the deterministic mock for the rolling note and
 *  an empty callback note, so a live outage never loses the summary — and we
 *  charge nothing. */
async function callOpenAi(
  apiKey: string,
  args: {
    existing: string;
    transcript: string;
    latest: string;
    company: string;
    contacts: string;
  },
): Promise<{
  rollingSummary: string;
  callbackNotes: string;
  promptTokens: number;
  completionTokens: number;
}> {
  const fallback = {
    rollingSummary: mockMerge(args.existing, args.latest || args.transcript),
    callbackNotes: "",
    promptTokens: 0,
    completionTokens: 0,
  };

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
            name: "call_context",
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
  if (!content) {
    return { ...fallback, promptTokens, completionTokens };
  }
  try {
    const parsed = JSON.parse(content) as {
      rolling_summary?: unknown;
      callback_notes?: unknown;
    };
    const rollingSummary =
      typeof parsed.rolling_summary === "string" &&
      parsed.rolling_summary.trim()
        ? parsed.rolling_summary.trim()
        : fallback.rollingSummary;
    const callbackNotes =
      typeof parsed.callback_notes === "string"
        ? parsed.callback_notes.trim()
        : "";
    return { rollingSummary, callbackNotes, promptTokens, completionTokens };
  } catch {
    return { ...fallback, promptTokens, completionTokens };
  }
}
