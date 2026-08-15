import type { AgentScript, KeyDetail } from "@/lib/agents/templates/types";

/** Representative lead values so a non-techy user sees a real-sounding opening
 *  instead of raw placeholders. Mirrors the sample context the campaign Test
 *  call tab uses. */
const SAMPLE: Record<string, string> = {
  "[name]": "Jamie",
  "[industry]": "gym",
  "{{business_name}}": "Jamie's Gym",
  "{{owner_name}}": "Jamie",
};

function fillSample(text: string): string {
  let out = text;
  for (const [token, value] of Object.entries(SAMPLE)) {
    out = out.split(token).join(value);
  }
  return out;
}

function formatDetail(d: KeyDetail): string {
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

export type ScriptPreview = {
  opening: string;
  specifics: { label: string; value: string }[];
};

/** Deterministic preview: the first line or two of the script with sample lead
 *  values filled in, plus the specifics the agent will rely on. No AI. */
export function previewScript(script: AgentScript): ScriptPreview {
  const firstChunk =
    script.scriptProse
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)[0] ?? "";
  return {
    opening: firstChunk ? fillSample(firstChunk) : "",
    specifics: script.keyDetails
      .filter((d) => d.value.trim())
      .map((d) => ({ label: d.label, value: formatDetail(d) })),
  };
}
