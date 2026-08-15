// src/lib/ai/split-agent-template.ts
import { SHARED_INSTRUCTIONS } from "@/lib/agents/templates/instructions";
import {
  normalizeKeyDetails,
  type KeyDetail,
} from "@/lib/agents/templates/types";
import { openAiKey } from "@/lib/openai/live";

export interface TemplateSplit {
  name: string;
  description: string;
  instructions: string;
  purpose: string;
  goal: string;
  keyDetails: KeyDetail[];
  scriptProse: string;
  source: "openai" | "fallback";
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" && v.trim() ? v : fallback;
}

/** Parse the model's JSON reply into a TemplateSplit. Returns null if the text
 *  isn't valid JSON. Missing fields degrade to sensible defaults; key details
 *  are normalized (dates stay typed). Pure + deterministic. */
export function parseSplitResponse(
  text: string,
  agentName: string,
): TemplateSplit | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  return {
    name: str(parsed.name, agentName),
    description: str(parsed.description),
    instructions: str(parsed.instructions, SHARED_INSTRUCTIONS),
    purpose: str(parsed.purpose),
    goal: str(parsed.goal),
    keyDetails: normalizeKeyDetails(parsed.keyDetails),
    scriptProse: str(parsed.scriptProse),
    source: "openai",
  };
}

function fallbackSplit(agentName: string, text: string): TemplateSplit {
  return {
    name: agentName,
    description: "",
    instructions: SHARED_INSTRUCTIONS,
    purpose: "",
    goal: "",
    keyDetails: [],
    scriptProse: text,
    source: "fallback",
  };
}

const SYSTEM_PROMPT = `You convert an existing outbound phone-agent prompt into a reusable template by separating two layers.
Reply ONLY with a JSON object with these string keys (plus keyDetails):
- "name": a short template name (3-5 words)
- "description": one line for a gallery card
- "instructions": the DURABLE, campaign-agnostic behavior only — turn-taking, natural human delivery, gatekeeper handling, do-not-call rules, voicemail/IVR handling, AI-disclosure. Remove every campaign specific (company, rep name, event, product, dates).
- "purpose": one line — what this agent is for
- "goal": one line — what counts as success
- "scriptProse": the conversational flow (opener, pitch, objections, sign-off) with the concrete facts REMOVED and referred to generically
- "keyDetails": an array of the concrete facts you removed, each {"label","type","value","required"} where type is "text" | "date" | "time". ANY calendar date MUST be type "date" with value as YYYY-MM-DD. Include rep name, company, event/offer name, dates, times.
Keep instructions faithful to the original behavior. Do not invent facts.`;

/** Split an agent's prompt into a template proposal. Live OpenAI when a key is
 *  set; otherwise (or on any failure/empty input) a graceful fallback that drops
 *  the raw prompt into the script for the admin to split by hand. Never throws. */
export async function splitAgentIntoTemplate(
  promptText: string,
  agentName: string,
): Promise<TemplateSplit> {
  const text = promptText.trim();
  const apiKey = openAiKey();
  if (!apiKey || !text) return fallbackSplit(agentName, text);

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) return fallbackSplit(agentName, text);
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content ?? "";
    return (
      parseSplitResponse(content, agentName) ?? fallbackSplit(agentName, text)
    );
  } catch {
    return fallbackSplit(agentName, text);
  }
}
