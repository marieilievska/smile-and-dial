import type { AgentTemplate } from "./types";
import { WEBINAR_TEMPLATE } from "./webinar";
import { BLANK_TEMPLATE } from "./blank";

export * from "./types";

/** All seeded starting templates, in gallery order. */
export const AGENT_TEMPLATES: AgentTemplate[] = [
  WEBINAR_TEMPLATE,
  BLANK_TEMPLATE,
];

export function getTemplate(key: string): AgentTemplate | undefined {
  return AGENT_TEMPLATES.find((t) => t.key === key);
}
