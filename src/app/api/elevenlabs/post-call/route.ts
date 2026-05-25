import { NextResponse, type NextRequest } from "next/server";

import {
  isValidElevenLabsSignature,
  processElevenLabsPostCall,
  type ElevenLabsPostCallPayload,
} from "@/lib/elevenlabs/post-call-webhook";

/**
 * ElevenLabs post-call webhook receiver.
 *
 * ElevenLabs POSTs `application/json` once per conversation when the call
 * ends. The body carries the transcript, analysis (summary + data
 * collection + evaluation), and metadata (duration, cost, recording URL).
 *
 * Like the Twilio status webhook, we always return 2xx for logically-
 * recognized requests even when there's nothing to do (`duplicate`,
 * `unknown_conversation`) to keep ElevenLabs from entering a retry storm
 * for events we can't act on.
 */
export async function POST(request: NextRequest) {
  // Read the raw body once; we need it for both signature validation and
  // JSON parsing.
  const rawBody = await request.text();
  const signature = request.headers.get("elevenlabs-signature");
  if (!isValidElevenLabsSignature({ body: rawBody, signature })) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
  }

  let payload: ElevenLabsPostCallPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const result = await processElevenLabsPostCall(payload);
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 500 });
  }
  return NextResponse.json({ status: result.status });
}
