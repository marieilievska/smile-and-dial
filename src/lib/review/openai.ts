import "server-only";
import { openAiKey } from "@/lib/openai/live";
import { priceOpenAiTokens } from "@/lib/costs/rates";

export const PASS1_MODEL =
  process.env.REVIEW_PASS1_MODEL?.trim() || "gpt-5.4-mini";
export const PASS2_MODEL = process.env.REVIEW_PASS2_MODEL?.trim() || "gpt-5.4";

export type JsonCallResult<T> = { data: T | null; cost: number; live: boolean };

/**
 * Call OpenAI chat-completions with a strict JSON schema. Returns parsed data
 * (or null on failure) + priced cost. When no OPENAI_API_KEY is set, returns
 * `mock` so tests never hit the network.
 */
export async function callOpenAiJson<T>(args: {
  model: string;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  schemaName: string;
  mock: T;
}): Promise<JsonCallResult<T>> {
  const apiKey = openAiKey();
  if (!apiKey) return { data: args.mock, cost: 0, live: false };

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: args.model,
        messages: [
          { role: "system", content: args.system },
          { role: "user", content: args.user },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: args.schemaName,
            strict: true,
            schema: args.schema,
          },
        },
      }),
    });
    if (!res.ok) return { data: null, cost: 0, live: true };
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = body.choices?.[0]?.message?.content;
    const cost = priceOpenAiTokens(
      body.usage?.prompt_tokens ?? 0,
      body.usage?.completion_tokens ?? 0,
    );
    if (!content) return { data: null, cost, live: true };
    try {
      return { data: JSON.parse(content) as T, cost, live: true };
    } catch {
      return { data: null, cost, live: true };
    }
  } catch {
    return { data: null, cost: 0, live: true };
  }
}
