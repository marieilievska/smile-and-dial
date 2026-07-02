import { createClient } from "@supabase/supabase-js";

import { priceOpenAiTokens } from "@/lib/costs/rates";

import { openAiKey } from "./live";

/**
 * Rolling AI summary merger (Step 39 / BUILD_PLAN §13).
 *
 * After each call, we merge ElevenLabs' per-call summary into the lead's
 * rolling `ai_summary` so the next outbound dial gets context about
 * everything that's happened before.
 *
 * Cost: priced from the actual gpt-4o-mini token usage the API returns, via the
 * central rates module. Live whenever an OpenAI key is configured.
 *
 * Returns the new summary string (or null if nothing was updated).
 */
export async function mergeLeadSummary(input: {
  leadId: string;
  campaignId: string;
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

  // Read the existing summary from the per-campaign row.
  const { data: existingRow } = await supabase
    .from("lead_campaign_summaries")
    .select("ai_summary")
    .eq("lead_id", input.leadId)
    .eq("campaign_id", input.campaignId)
    .maybeSingle();
  const existing = (existingRow?.ai_summary ?? "").trim();

  // Pull the last 5 call summaries for this campaign for context.
  const { data: recentCalls } = await supabase
    .from("calls")
    .select("summary, created_at")
    .eq("lead_id", input.leadId)
    .eq("campaign_id", input.campaignId)
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
    const result = await callOpenAi(apiKey, existing, latest);
    newSummary = result.text;
    cost = priceOpenAiTokens(result.promptTokens, result.completionTokens);
  } else {
    newSummary = mockMerge(existing, latest);
  }

  // Upsert the per-campaign summary row and copy to leads.ai_summary
  // (denormalized "latest campaign summary" for the leads list + CSV).
  // The per-campaign row is authoritative; the leads.ai_summary copy is a
  // best-effort convenience. Writing the row first means a failure of the
  // second write only leaves the denormalized copy briefly stale — the next
  // successful merge self-heals both.
  await supabase.from("lead_campaign_summaries").upsert(
    {
      lead_id: input.leadId,
      campaign_id: input.campaignId,
      ai_summary: newSummary,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "lead_id,campaign_id" },
  );
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
): Promise<{ text: string; promptTokens: number; completionTokens: number }> {
  const userPrompt = `Existing note about this lead:
${existing || "(none yet)"}

Newest call summary:
${latest}

Rewrite the running note as a FACTUAL record for the next caller. Past tense
(these calls already happened). Capture ONLY:
- Who/what we know about the lead (name/role IF given, business specifics, hours).
- What actually happened and what the LEAD said — their questions, objections,
  stated interest/disinterest. If they didn't engage (hold, hang-up, voicemail,
  gatekeeper only), say plainly what blocked us.
- REACHABILITY as facts: who we can/can't reach and who handles things — e.g.
  "owner is never on-site; the front desk/manager <name> handles leads; best
  contact is email <x>". State the facts; do NOT prescribe a next action.
- The lead's own stated pain point, ONLY if the LEAD raised it. Never guess one.
- A commitment ONLY if the lead explicitly agreed (callback time, permission to
  send info). If none, say no commitment was made.

Do NOT restate the agent's pitch/questions as the lead's interest. Do NOT invent
details. Do NOT include dates or "X ago" timing. Do NOT tell the next caller what
to DO ("email the owner", "call back and pitch X") — record the facts and let the
caller decide. Write 2–5 short sentences. Max 200 words. No filler.`;

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
    // the latest summary just because OpenAI is down (and we charge nothing).
    return {
      text: mockMerge(existing, latest),
      promptTokens: 0,
      completionTokens: 0,
    };
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    text:
      data.choices?.[0]?.message?.content?.trim() ??
      mockMerge(existing, latest),
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
  };
}
