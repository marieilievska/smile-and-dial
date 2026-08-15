import type { AgentScript } from "@/lib/agents/templates/types";

/** Plain-English reasons the agent can't be saved yet. Empty array = OK to save.
 *  This is the structural guarantee against shipping a blank/stale required
 *  fact (e.g. an empty event date). */
export function validateScript(name: string, script: AgentScript): string[] {
  const errors: string[] = [];
  if (!name.trim()) errors.push("Give the agent a name.");
  if (!script.purpose.trim()) errors.push("Add a purpose.");
  if (!script.goal.trim()) errors.push("Add a goal.");
  for (const d of script.keyDetails) {
    if (d.required && !d.value.trim()) errors.push(`Fill in "${d.label}".`);
  }
  return errors;
}
