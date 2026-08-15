import {
  ALL_TOOLS,
  LEAD_CONTEXT_BLOCK,
  TOOL_ERROR_HANDLING_BLOCK,
  TOOL_BLOCKS_PUBLIC as TOOL_BLOCKS,
  type ToolsEnabled,
} from "@/lib/agents/prompt";
import type { AgentScript, KeyDetail } from "@/lib/agents/templates/types";

/** Human-format a key detail's value for the prompt. Dates become e.g.
 *  "Wednesday, August 27, 2026"; everything else passes through verbatim. */
function formatDetailValue(d: KeyDetail): string {
  if (d.type === "date" && /^\d{4}-\d{2}-\d{2}$/.test(d.value)) {
    const parsed = new Date(`${d.value}T00:00:00`);
    if (!Number.isNaN(parsed.getTime())) {
      return new Intl.DateTimeFormat("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      }).format(parsed);
    }
  }
  return d.value;
}

/** Render the filled key details into a single "specifics" block, or "" if none
 *  have a value. This is the ONE place a fact like the event date appears. */
export function renderKeyDetails(details: KeyDetail[]): string {
  const filled = details.filter((d) => d.value.trim().length > 0);
  if (filled.length === 0) return "";
  const lines = filled.map((d) => `- ${d.label}: ${formatDetailValue(d)}`);
  return `# The specifics — use these exact facts\n${lines.join("\n")}`;
}

export type AssembleInput = {
  instructions: string;
  script: AgentScript;
  toolsEnabled: ToolsEnabled;
};

/** Glue the locked instructions + editable script + shared blocks into the
 *  final ElevenLabs system prompt. Empty script sections are omitted. */
export function assembleFromScript(input: AssembleInput): string {
  const { instructions, script, toolsEnabled } = input;
  const sections: string[] = [instructions.trim()];

  if (script.purpose.trim())
    sections.push(`# Your job\n${script.purpose.trim()}`);
  if (script.goal.trim()) sections.push(`# Your goal\n${script.goal.trim()}`);

  const specifics = renderKeyDetails(script.keyDetails);
  if (specifics) sections.push(specifics);

  if (script.scriptProse.trim())
    sections.push(`# What to say\n${script.scriptProse.trim()}`);

  const enabled = ALL_TOOLS.filter((k) => toolsEnabled[k]);
  if (enabled.length > 0) {
    sections.push(
      "# Tools\n\n" + enabled.map((k) => TOOL_BLOCKS[k]).join("\n\n"),
    );
  }

  sections.push(LEAD_CONTEXT_BLOCK);
  sections.push(TOOL_ERROR_HANDLING_BLOCK);

  return sections.join("\n\n");
}
