import { NextResponse, type NextRequest } from "next/server";

import {
  executeServerTool,
  isServerToolKey,
  isValidToolSecret,
} from "@/lib/elevenlabs/tool-webhook";

/**
 * ElevenLabs server-tool webhook dispatch.
 *
 * One route handles every custom tool (see SERVER_TOOL_KEYS), keyed by the
 * [tool] segment. Each tool is registered with ElevenLabs pointing at
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

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Shared secret arrives as a `tool_secret` body field (a constant baked into
  // the tool definition), since ElevenLabs tool params live in the body.
  // Skipped in non-live mode so Playwright can POST without a secret.
  const secret = typeof body.tool_secret === "string" ? body.tool_secret : null;
  if (!(await isValidToolSecret(secret))) {
    return NextResponse.json({ error: "Invalid secret" }, { status: 403 });
  }

  const result = await executeServerTool(tool, body);
  // Always 200 so a tool-level failure surfaces as a spoken message to the
  // caller (via the LLM) rather than an opaque HTTP error mid-conversation.
  return NextResponse.json(result, { status: 200 });
}
