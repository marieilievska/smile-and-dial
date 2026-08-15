// src/lib/ai/tidy-prose.ts
import { openAiKey } from "@/lib/openai/live";

const SYSTEM_PROMPT = `You clean up the wording of an outbound phone-agent script.
Fix grammar, flow, and clarity ONLY. Do not change the meaning, the offer, the
facts, or the structure. Keep it roughly the same length. Reply with ONLY the
cleaned text — no preamble, no quotes, no markdown.`;

/** Grammar/flow cleanup of the script prose, meaning preserved. Live OpenAI when
 *  a key is set; otherwise returns the input unchanged. Never throws. */
export async function tidyProse(text: string): Promise<string> {
  const apiKey = openAiKey();
  if (!apiKey || !text.trim()) return text;
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
      }),
    });
    if (!res.ok) return text;
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const cleaned = data.choices?.[0]?.message?.content?.trim();
    return cleaned && cleaned.length > 0 ? cleaned : text;
  } catch {
    return text;
  }
}
