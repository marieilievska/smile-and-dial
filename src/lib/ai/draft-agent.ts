/**
 * Draft the prompt blocks of a voice agent from a one-line plain-English
 * description. Mirrors the rolling-summary merger convention: live mode is
 * a plain fetch to OpenAI gated behind OPENAI_LIVE=live + OPENAI_API_KEY,
 * and everything else falls back to a deterministic mock so the feature
 * works in local dev and CI without spend or an SDK dependency.
 */
export interface AgentDraft {
  name: string;
  personality: string;
  environment: string;
  tone: string;
  goal: string;
  guardrails: string;
  source: "openai" | "mock";
}

const DRAFT_KEYS = [
  "name",
  "personality",
  "environment",
  "tone",
  "goal",
  "guardrails",
] as const;

export async function draftAgent(description: string): Promise<AgentDraft> {
  const trimmed = description.replace(/\s+/g, " ").trim();
  if (!trimmed) return { ...emptyDraft(), source: "mock" };

  const live = process.env.OPENAI_LIVE === "live";
  const apiKey = process.env.OPENAI_API_KEY;
  if (!live || !apiKey) return mockDraft(trimmed);

  try {
    return await callOpenAi(apiKey, trimmed);
  } catch {
    return mockDraft(trimmed);
  }
}

function emptyDraft(): Omit<AgentDraft, "source"> {
  return {
    name: "",
    personality: "",
    environment: "",
    tone: "",
    goal: "",
    guardrails: "",
  };
}

/** Live mode: plain fetch to OpenAI in JSON mode (no SDK dependency). */
async function callOpenAi(
  apiKey: string,
  description: string,
): Promise<AgentDraft> {
  const systemPrompt = `You design system prompts for outbound AI phone agents that call sales leads.
Given a short plain-English description of what an agent should do, write the blocks below.
Reply ONLY with a JSON object with exactly these string keys:
- "name": a short internal label (3-5 words, no quotes)
- "personality": who the agent is (2-3 sentences, second person, e.g. "You are...")
- "environment": the call context (1-2 sentences)
- "tone": how it speaks (1-2 sentences)
- "goal": the single concrete outcome of the call (1-2 sentences)
- "guardrails": hard limits, one per line, each starting with "Never" or "Always"
Keep every block tight and specific to the description. Do not add markdown headings.`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: description },
      ],
      temperature: 0.5,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) return mockDraft(description);

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = data.choices?.[0]?.message?.content ?? "";
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const draft = emptyDraft();
  for (const key of DRAFT_KEYS) {
    const value = parsed[key];
    if (typeof value === "string") draft[key] = value.trim();
  }
  if (!draft.name) draft.name = deriveName(description);
  return { ...draft, source: "openai" };
}

/** Deterministic, genuinely-usable draft so the feature works without a
 *  key. It reflects the description into each block rather than emitting
 *  placeholder lorem. */
function mockDraft(description: string): AgentDraft {
  const lower = description.charAt(0).toLowerCase() + description.slice(1);
  return {
    name: deriveName(description),
    personality: `You are a friendly, knowledgeable outbound representative. Your job is to ${lower} You are confident and helpful without being pushy.`,
    environment: `You are on a live phone call with a lead who recently showed interest. They may be busy, so respect their time and get to the point quickly.`,
    tone: `Warm, concise, and natural. Speak in plain language, avoid jargon, and keep responses short so the conversation feels like a real person.`,
    goal: `By the end of the call, ${lower} Confirm the outcome out loud before ending the call.`,
    guardrails: [
      "Never promise discounts, pricing, or terms you were not told to offer.",
      "Never disparage competitors.",
      "Always honor a request to stop or to be removed from the list.",
      "Always hand off to a human if the lead asks for one.",
    ].join("\n"),
    source: "mock",
  };
}

function deriveName(description: string): string {
  const words = description
    .replace(/[^a-zA-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4);
  if (words.length === 0) return "Outbound assistant";
  const label = words.join(" ");
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} agent`;
}
