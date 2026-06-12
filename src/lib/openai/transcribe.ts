import { openAiKey } from "./live";

/** Transcribe an audio URL with OpenAI Whisper. The Twilio recording URL needs
 *  Basic auth (account SID : auth token). Returns null in mock mode or on
 *  failure so callers degrade gracefully. */
export async function transcribeAudioUrl(
  recordingUrl: string,
): Promise<string | null> {
  const apiKey = openAiKey();
  if (!apiKey) return null;

  const sid = process.env.TWILIO_ACCOUNT_SID ?? "";
  const token = process.env.TWILIO_AUTH_TOKEN ?? "";
  const basic = Buffer.from(`${sid}:${token}`).toString("base64");

  const audioRes = await fetch(`${recordingUrl}.mp3`, {
    headers: { Authorization: `Basic ${basic}` },
  });
  if (!audioRes.ok) return null;
  const buf = Buffer.from(await audioRes.arrayBuffer());

  const form = new FormData();
  form.append("file", new Blob([buf], { type: "audio/mpeg" }), "call.mp3");
  form.append("model", "whisper-1");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { text?: string };
  return json.text?.trim() || null;
}

/** Summarize a single call transcript into 1–2 sentences. Null in mock mode. */
export async function summarizeTranscript(
  transcript: string,
): Promise<string | null> {
  const apiKey = openAiKey();
  if (!apiKey || !transcript.trim()) return null;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Summarize this sales call transcript in 1-2 sentences: what happened and any next step. Be concise and factual.",
        },
        { role: "user", content: transcript.slice(0, 12_000) },
      ],
      max_tokens: 120,
    }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return json.choices?.[0]?.message?.content?.trim() || null;
}
