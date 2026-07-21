/**
 * Assemble the 6-block ElevenLabs agent prompt from the wizard inputs.
 * Per BUILD_PLAN.md Section 9.
 */

export const ALL_TOOLS = [
  "send_email",
  "send_text",
  "schedule_callback",
  "get_available_times",
  "book_appointment",
  "mark_dnc",
  "demo_front_desk",
  "transfer_to_number",
] as const;

export type ToolKey = (typeof ALL_TOOLS)[number];

export type ToolsEnabled = Partial<Record<ToolKey, boolean>>;

/** Prefix for our custom server tools' ElevenLabs function names. The
 *  ElevenLabs workspace is SHARED across many Referrizer products (1000+
 *  tools), with generic names like `book_appointment` / `schedule_callback`
 *  already taken. Namespacing guarantees we only ever create/patch our own
 *  tools and never hijack another team's identically-named tool. The internal
 *  ToolKey (and our webhook path) stays unprefixed; only the LLM-facing
 *  function name is namespaced. transfer_to_number is a built-in system tool
 *  and is NOT prefixed. */
export const SERVER_TOOL_FUNCTION_PREFIX = "smiledial_";

export const TOOL_LABELS: Record<ToolKey, string> = {
  send_email: "Send email",
  send_text: "Send text (SMS)",
  schedule_callback: "Schedule a callback",
  get_available_times: "Get available times (Calendly)",
  book_appointment: "Book an appointment (Calendly)",
  mark_dnc: "Add the lead to do-not-call",
  demo_front_desk: "Front-desk demo research",
  transfer_to_number: "Transfer to a human",
};

const TOOL_BLOCKS: Record<ToolKey, string> = {
  send_email: `## smiledial_send_email
**When to use:** When the lead requests information by email during the call, or asks to be sent details.
**How to use:**
1. Confirm the lead's email address by reading it back to them.
2. Call the tool with their confirmed email.
3. Tell them "I've sent that over — you should see it within a minute."`,
  send_text: `## smiledial_send_text
**When to use:** ONLY when the lead explicitly asks you to text them something (e.g. "can you text me that?"). Never offer, suggest, or bring up texting yourself — only act when they ask.
**How to use:**
1. Ask for and read back their MOBILE number to confirm it — a text can't reach a landline, so don't use the number you called unless they say it's a cell.
2. Call the tool with their confirmed mobile number.
3. Tell them "I've texted that to you — you should see it shortly." Every text includes a way to opt out.`,
  schedule_callback: `## smiledial_schedule_callback
**When to use:** When the lead says they're busy now and asks to be called back at a specific time.
**How to use:**
1. Confirm the date and time clearly: "So that's Tuesday the 15th at 2 PM your local time, correct?"
2. Call the tool with the confirmed datetime in ISO 8601 format (e.g., "2026-01-15T14:00:00-06:00").`,
  get_available_times: `## smiledial_get_available_times
**When to use:** When the lead expresses interest in scheduling a meeting and you need to offer specific time slots.
**How to use:** Call this tool to retrieve current availability, then offer 2–3 options to the lead.`,
  book_appointment: `## smiledial_book_appointment
**When to use:** After the lead has chosen a specific time slot from the options you offered.
**How to use:**
1. Confirm the chosen time.
2. Call the tool with the slot ID and the lead's name and email.
3. Tell them they'll receive a calendar invite shortly.`,
  mark_dnc: `## smiledial_mark_dnc
**When to use:** When the lead explicitly asks to be removed from the calling list, or says "don't call me again."
**How to use:**
1. Confirm: "I understand, I'll make sure you're not contacted again."
2. Call the tool.`,
  demo_front_desk: `## smiledial_demo_front_desk
**When to use:** ONLY when the instructions above describe a front-desk demo AND the caller has agreed to hear one. Never call it just to answer a question about the product.
**How to use:**
1. Tell them you're pulling their business up — the lookup takes a few seconds.
2. The tool returns a brief. Open with its \`receptionist_greeting\`, and answer as their front desk using \`services\` and \`common_caller_reasons\`.
3. Never state anything listed in \`do_not_claim\` — say you'd have to check on that.
4. If \`found\` is false, keep it general: play the part without naming specific services or prices.`,
  transfer_to_number: `## transfer_to_number
**When to use:** When the lead asks to speak with a human, or when the conversation requires escalation beyond what you can handle.
**How to use:**
1. Tell the lead "Let me connect you with someone who can help."
2. Call the tool — the call will be transferred immediately.`,
};

const LEAD_CONTEXT_BLOCK = `# Lead context
Here's what we know about this lead from previous calls. Use this to avoid repeating yourself and pick up where the last conversation left off.

Summary of our last call: {{last_call_summary}}
Callback notes: {{last_callback_notes}}

If both are empty, this is the first call with this lead — introduce yourself and the company normally.`;

const TOOL_ERROR_HANDLING_BLOCK = `# Tool error handling
If any tool fails:
1. Acknowledge: "I'm having trouble with that right now."
2. Do not guess or make up information.
3. Offer to follow up later or escalate.`;

export type PromptInputs = {
  personality: string;
  environment: string;
  tone: string;
  goal: string;
  guardrails: string;
  toolsEnabled: ToolsEnabled;
};

/** Build the system prompt from the wizard inputs. */
export function assemblePrompt(input: PromptInputs): string {
  const sections: string[] = [
    "# Personality\n" + (input.personality.trim() || "_Not specified._"),
    "# Environment\n" + (input.environment.trim() || "_Not specified._"),
    "# Tone\n" + (input.tone.trim() || "_Not specified._"),
    "# Goal\n" + (input.goal.trim() || "_Not specified._"),
    "# Guardrails\n" + (input.guardrails.trim() || "_None specified._"),
  ];

  const enabled = ALL_TOOLS.filter((key) => input.toolsEnabled[key]);
  if (enabled.length > 0) {
    sections.push(
      "# Tools\n\n" + enabled.map((k) => TOOL_BLOCKS[k]).join("\n\n"),
    );
  }

  sections.push(LEAD_CONTEXT_BLOCK);
  sections.push(TOOL_ERROR_HANDLING_BLOCK);

  return sections.join("\n\n");
}
