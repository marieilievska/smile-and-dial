import { createClient } from "@supabase/supabase-js";

import { openAiKey } from "./live";

/**
 * Rolling AI summary merger (Step 39 / BUILD_PLAN §13).
 *
 * After each call, we merge ElevenLabs' per-call summary into the lead's
 * rolling `ai_summary` so the next outbound dial gets context about
 * everything that's happened before.
 *
 * Cost: ~$0.001 per call with gpt-4o-mini in live mode. Hard-gated behind
 * OPENAI_LIVE=live so we don't spend on accident.
 *
 * Returns the new summary string (or null if nothing was updated).
 */
export async function mergeLeadSummary(input: {
  leadId: string;
  latestSummary?: string | null;
}): Promise<{
  newSummary: string | null;
  cost: number;
  mode: "mock" | "live";
}> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !serviceKey) {
    return { newSummary: null, cost: 0, mode: "mock" };
  }
  const supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: lead } = await supabase
    .from("leads")
    .select("ai_summary")
    .eq("id", input.leadId)
    .maybeSingle();
  if (!lead) {
    return { newSummary: null, cost: 0, mode: "mock" };
  }
  const existing = (lead.ai_summary ?? "").trim();

  // Pull the last 5 call summaries for context.
  const { data: recentCalls } = await supabase
    .from("calls")
    .select("summary, created_at")
    .eq("lead_id", input.leadId)
    .not("summary", "is", null)
    .order("created_at", { ascending: false })
    .limit(5);
  const recent = (recentCalls ?? [])
    .map((c) => c.summary)
    .filter((s): s is string => !!s);

  const latest = input.latestSummary?.trim() || recent[0] || "";
  if (!latest) {
    // Nothing new to merge — bail without writing.
    return { newSummary: null, cost: 0, mode: "mock" };
  }

  const apiKey = openAiKey();
  const live = Boolean(apiKey);
  let newSummary: string;
  let cost = 0;
  if (apiKey) {
    newSummary = await callOpenAi(apiKey, existing, latest);
    // gpt-4o-mini cost approximation: ~$0.001 per call per spec.
    cost = 0.001;
  } else {
    newSummary = mockMerge(existing, latest);
  }

  await supabase
    .from("leads")
    .update({ ai_summary: newSummary })
    .eq("id", input.leadId);

  return { newSummary, cost, mode: live ? "live" : "mock" };
}

/** Deterministic concatenation used in mock mode. Pruned to 200 words. */
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

/** Live mode: call OpenAI's chat-completions API with the §13 prompt. We
 *  do this via plain fetch so we don't add an SDK dependency for a single
 *  call. */
async function callOpenAi(
  apiKey: string,
  existing: string,
  latest: string,
): Promise<string> {
  const userPrompt = `Existing note about this lead:
${existing || "(none yet)"}

Newest call summary:
${latest}

Rewrite the running note so the NEXT caller knows what happened and what to do.
Capture, factually and in PAST tense (these calls already happened):
- Who/what we know about the lead (their name or role IF they gave it, business
  specifics, hours).
- What actually happened on the last call and what the LEAD themselves said —
  their questions, objections, or stated interest/disinterest. If the lead
  didn't really engage (put us on hold, hung up, went to voicemail, or we only
  reached a gatekeeper), say plainly what blocked us.
- The lead's main challenge or pain point IN THEIR OWN BUSINESS — what they
  said they struggle with (e.g. no-shows, slow seasons, staffing, getting
  reviews, retaining members) — but ONLY if the LEAD themselves raised it. If
  they mentioned no problem, leave it out; never guess one.
- A commitment ONLY if the lead explicitly agreed to one (a callback time,
  permission to send info). If none, say no commitment was made.
- What the next caller should DO or open with, given how this went.

Do NOT restate the agent's pitch or questions as the lead's interest. Do NOT
invent details. Do NOT include dates or "X ago" timing — the caller is told
separately how long ago the last call was.

Write 2–5 short sentences in this shape:
"We know X (include their main struggle if they shared one). Last call: Y.
Next time: Z."
Max 200 words. No filler.`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You maintain a short, factual running context note about a sales " +
            "lead, written for the next cold-caller who will phone them. " +
            "Attribution is critical: every call is between OUR agent (e.g. " +
            "'Jack from Referrizer') and the lead (the business we're calling). " +
            "The agent's pitch, questions, and talking points are NOT the " +
            "lead's views. Never write that the lead wants, likes, is " +
            "interested in, or agreed to something unless the LEAD clearly " +
            "said so themselves. If the agent asked a question the lead didn't " +
            "answer, the lead's position is still unknown — say that. Do not " +
            "infer interest from the fact that the agent made a pitch. When in " +
            "doubt, under-claim.",
        },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 400,
    }),
  });
  if (!res.ok) {
    // Live failures fall back to the mock merge — we never want to lose
    // the latest summary just because OpenAI is down.
    return mockMerge(existing, latest);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return (
    data.choices?.[0]?.message?.content?.trim() ?? mockMerge(existing, latest)
  );
}
