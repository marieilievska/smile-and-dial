import { priceOpenAiTokens } from "@/lib/costs/rates";

import { openAiKey } from "./live";

/** The model, matching summary-merger.ts (a reasoning model — no temperature /
 *  max_tokens). */
export const OBJECTION_MODEL =
  process.env.OBJECTION_MODEL?.trim() || "gpt-5.4-mini";

/** Fixed objection taxonomy. Stored verbatim in calls.objection_category. */
export const OBJECTION_CATEGORIES = [
  "price",
  "already_have_solution",
  "no_need",
  "bad_timing",
  "happy_with_current",
  "confused_by_offer",
  "distrust_spam",
  "brush_off",
  "other",
] as const;

export type ObjectionCategory = (typeof OBJECTION_CATEGORIES)[number];

export type Objection = {
  category: ObjectionCategory;
  specific: string;
  quote: string;
};

type TranscriptTurn = {
  role?: string | null;
  message?: string | null;
  time_in_call_secs?: number | null;
};

/** Render calls.transcript_json into "Agent:/Lead:" text in time order. Pure. */
export function transcriptToText(transcript: unknown): string {
  if (!Array.isArray(transcript)) return "";
  return (transcript as TranscriptTurn[])
    .filter((t) => t && typeof t.message === "string" && t.message.trim())
    .slice()
    .sort((a, b) => (a.time_in_call_secs ?? 0) - (b.time_in_call_secs ?? 0))
    .map(
      (t) => `${t.role === "agent" ? "Agent" : "Lead"}: ${t.message!.trim()}`,
    )
    .join("\n");
}

const SYSTEM_PROMPT = `You analyze a transcript of a cold sales call between OUR agent and a prospective business. The call did NOT close. Identify the LEAD's single main objection — the real reason they didn't move forward. Judge ONLY what the LEAD (the business) said; the agent's pitch is not an objection. If the lead raised no real objection (e.g. only a gatekeeper spoke, or nobody engaged), report objection_present=false.`;

const CATEGORY_GUIDE = `Choose the ONE category that best fits the lead's main objection:
- price: cost / too expensive / budget.
- already_have_solution: they already use a competitor or another tool (name it in "specific").
- no_need: it isn't relevant to their business / they don't do that.
- bad_timing: not right now / call back later / busy season.
- happy_with_current: satisfied with how they do it today, no pain.
- confused_by_offer: didn't understand what we were offering.
- distrust_spam: thinks it's a scam / spam / doesn't trust it.
- brush_off: "just email me" / non-committal deflection with no real reason.
- other: a real objection that fits none of the above.`;

/** Prompt for one call. Pure. */
export function buildObjectionPrompt(transcriptText: string): string {
  return `${CATEGORY_GUIDE}

Transcript:
${transcriptText}

Return JSON:
- "objection_present": true only if the LEAD gave a real objection; false otherwise.
- "category": one of exactly [${OBJECTION_CATEGORIES.join(", ")}].
- "specific": at most 12 words naming WHAT specifically — the competitor, the aspect, the reason (e.g. "already using Podium", "too pricey for a 2-chair salon", "no time this quarter"). Empty string if none.
- "quote": the LEAD's own words that carry the objection, copied VERBATIM from the transcript (at most ~200 chars). Empty string if none.`;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["objection_present", "category", "specific", "quote"],
  properties: {
    objection_present: { type: "boolean" },
    category: { type: "string" },
    specific: { type: "string" },
    quote: { type: "string" },
  },
};

/** Parse the model's JSON into an Objection, or null when absent/invalid.
 *  Unknown categories coerce to "other". Pure. */
export function parseObjectionResponse(content: string): Objection | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (parsed.objection_present !== true) return null;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const raw = str(parsed.category);
  const category = (
    (OBJECTION_CATEGORIES as readonly string[]).includes(raw) ? raw : "other"
  ) as ObjectionCategory;
  return { category, specific: str(parsed.specific), quote: str(parsed.quote) };
}

/** One live gpt-5.4-mini pass. Returns the objection (or null) + token cost +
 *  `ok` = "this call was DEFINITIVELY processed, safe to mark analyzed". `ok` is
 *  false for a config/transient failure (no key, network throw, non-2xx) so the
 *  caller leaves the call un-analyzed and retries it — instead of permanently
 *  blanking a whole batch during an OpenAI outage. An empty transcript is `ok`
 *  (nothing to analyze — terminal). Mirrors summary-merger.ts's callOpenAi. */
export async function extractObjection(transcriptText: string): Promise<{
  objection: Objection | null;
  cost: number;
  ok: boolean;
}> {
  const apiKey = openAiKey();
  if (!transcriptText.trim()) {
    // Nothing to analyze — terminal; mark it done so it isn't retried forever.
    return { objection: null, cost: 0, ok: true };
  }
  if (!apiKey) {
    // No key configured — config/transient; DON'T mark analyzed, retry later.
    return { objection: null, cost: 0, ok: false };
  }
  let res: Response;
  try {
    res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: OBJECTION_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildObjectionPrompt(transcriptText) },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "objection", strict: true, schema: SCHEMA },
        },
      }),
    });
  } catch {
    return { objection: null, cost: 0, ok: false };
  }
  if (!res.ok) return { objection: null, cost: 0, ok: false };
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  const cost = priceOpenAiTokens(
    data.usage?.prompt_tokens ?? 0,
    data.usage?.completion_tokens ?? 0,
    OBJECTION_MODEL,
  );
  return { objection: parseObjectionResponse(content), cost, ok: true };
}
