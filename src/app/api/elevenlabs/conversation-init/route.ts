import { NextResponse, type NextRequest } from "next/server";

import {
  buildConversationInitData,
  isValidConversationInitSecret,
  type ConversationInitRequest,
} from "@/lib/elevenlabs/conversation-init";

/**
 * ElevenLabs conversation-initiation client-data webhook.
 *
 * Configured ONCE on the ElevenLabs side as the agent's "Initiation Data
 * Webhook Override" and reused for every agent Smile & Dial creates. At the
 * start of each conversation ElevenLabs POSTs { caller_id, agent_id,
 * called_number, call_sid }; we resolve the call by call_sid and return a
 * `conversation_initiation_client_data` event whose dynamic_variables fill
 * the agent prompt's {{call_type}} / {{last_call_summary}} /
 * {{last_callback_notes}} placeholders, plus the per-campaign transfer
 * number.
 *
 * Always returns 200 with a complete variable set (blank when unresolved)
 * so a lookup miss never blocks the call from starting.
 */
export async function POST(request: NextRequest) {
  // Shared-secret header configured in the ElevenLabs webhook "Request
  // headers". Skipped in non-live mode so tests can POST without a secret.
  const secret =
    request.headers.get("x-init-secret") ??
    request.headers.get("x-webhook-secret");
  if (!isValidConversationInitSecret(secret)) {
    return NextResponse.json({ error: "Invalid secret" }, { status: 403 });
  }

  let body: ConversationInitRequest;
  try {
    body = (await request.json()) as ConversationInitRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const data = await buildConversationInitData(body);
  return NextResponse.json(data, { status: 200 });
}
