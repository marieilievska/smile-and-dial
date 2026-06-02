import { NextResponse, type NextRequest } from "next/server";

import {
  executeServerTool,
  isServerToolKey,
  isValidToolSecret,
} from "@/lib/elevenlabs/tool-webhook";

/**
 * ElevenLabs server-tool webhook dispatch.
 *
 * One route handles all five custom tools (send_email, schedule_callback,
 * get_available_times, book_appointment, mark_dnc), keyed by the [tool]
 * segment. Each tool is registered with ElevenLabs pointing at
 * /api/elevenlabs/tools/<tool> (see lib/elevenlabs/server-tools). When the
 * agent's LLM uses a tool mid-call, ElevenLabs POSTs the declared parameters
 * here as a flat JSON body — including the {{call_id}} we bound so we can
 * resolve the lead.
 *
 * We validate the shared secret once, dispatch, and return the handler's JSON
 * straight back — ElevenLabs feeds it to the LLM as the tool result.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tool: string }> },
) {
  const { tool } = await params;
  if (!isServerToolKey(tool)) {
    return NextResponse.json({ error: "Unknown tool" }, { status: 400 });
  }

  // Shared-secret header set on each tool definition. Skipped in non-live
  // mode so Playwright can POST without a secret.
  const secret = request.headers.get("x-tool-secret");
  if (!isValidToolSecret(secret)) {
    return NextResponse.json({ error: "Invalid secret" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const result = await executeServerTool(tool, body);
  // Always 200 so a tool-level failure surfaces as a spoken message to the
  // caller (via the LLM) rather than an opaque HTTP error mid-conversation.
  return NextResponse.json(result, { status: 200 });
}
