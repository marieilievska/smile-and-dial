// src/lib/ai/tidy-prose.ts
import {
  chatCompletionUsage,
  recordAiChargeAsService,
} from "@/lib/costs/ai-charges";
import { priceOpenAiTokens } from "@/lib/costs/rates";
import { openAiKey } from "@/lib/openai/live";

const TIDY_MODEL = "gpt-5.4";

const SYSTEM_PROMPT = `You clean up the wording of an outbound phone-agent script.
Fix grammar, flow, and clarity ONLY. Do not change the meaning, the offer, the
facts, or the structure. Keep it roughly the same length. Reply with ONLY the
cleaned text — no preamble, no quotes, no markdown.`;

export type TidyProseOptions = {
  /** Who to book the OpenAI spend to in `ai_charges`. Omit to skip the
   *  ledger (tests, offline). */
  ownerId?: string | null;
};

/** Grammar/flow cleanup of the script prose, meaning preserved. Live OpenAI when
 *  a key is set; otherwise returns the input unchanged. Never throws.
 *
 *  Server-side only in practice: the key lives in a server env var, so the UI
 *  reaches this through the `tidyProseAction` server action. */
export async function tidyProse(
  text: string,
  opts: TidyProseOptions = {},
): Promise<string> {
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
        model: TIDY_MODEL,
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
    const usage = chatCompletionUsage(data);
    if (opts.ownerId && (usage.inputTokens > 0 || usage.outputTokens > 0)) {
      await recordAiChargeAsService({
        ownerId: opts.ownerId,
        kind: "tidy_prose",
        model: TIDY_MODEL,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cost: priceOpenAiTokens(
          usage.inputTokens,
          usage.outputTokens,
          TIDY_MODEL,
        ),
      });
    }
    const cleaned = data.choices?.[0]?.message?.content?.trim();
    return cleaned && cleaned.length > 0 ? cleaned : text;
  } catch {
    return text;
  }
}
