import type { AgentTemplate } from "./types";
import { SHARED_INSTRUCTIONS } from "./instructions";
import { FIXED_VOICES } from "@/lib/elevenlabs/voices";

/** Empty starting point — same proven behavior, no script yet. For a purpose
 *  that matches no other card. */
export const BLANK_TEMPLATE: AgentTemplate = {
  key: "blank",
  name: "Blank / from scratch",
  description:
    "Same proven behavior, an empty script. Build any purpose from zero.",
  instructions: SHARED_INSTRUCTIONS,
  defaultVoiceId: FIXED_VOICES[0].id,
  tools: { schedule_callback: true, mark_dnc: true },
  script: {
    purpose: "",
    goal: "",
    keyDetails: [],
    scriptProse: "",
    dataCollection: [],
  },
};
