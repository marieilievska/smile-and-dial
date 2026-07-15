import "server-only";
import { buildRubricText } from "./rubric";
import { callOpenAiJson, PASS1_MODEL, PASS2_MODEL } from "./openai";
import type { ProposedFlag, ReviewFlagDef, VerifiedFlag } from "./types";
import { OFF_SCRIPT_KEY, rubricDefsForReview } from "./instructions";

const CONFIDENCE_FLOOR = 0.6; // below this (or on disagreement) -> needs_review

type Verdict = { agree: boolean; confidence: number; evidence_quote: string };

/** Deterministic merge of Pass 1 proposals + Pass 2 verdicts. Pure — unit tested. */
export function mergeVerification(
  proposed: ProposedFlag[],
  verdicts: Record<string, Verdict>,
): VerifiedFlag[] {
  const out: VerifiedFlag[] = [];
  for (const p of proposed) {
    const v = verdicts[p.flag_key];
    if (!v) {
      out.push({ ...p, status: "needs_review" });
      continue;
    }
    if (!v.agree) continue; // refuted -> drop
    const confidence = Math.min(p.confidence, v.confidence);
    out.push({
      flag_key: p.flag_key,
      evidence_quote: v.evidence_quote || p.evidence_quote,
      confidence,
      status: confidence >= CONFIDENCE_FLOOR ? "confirmed" : "needs_review",
    });
  }
  return out;
}

const PASS1_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["flags"],
  properties: {
    flags: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["flag_key", "evidence_quote", "confidence"],
        properties: {
          flag_key: { type: "string" },
          evidence_quote: { type: "string" },
          confidence: { type: "number" },
        },
      },
    },
  },
};

const PASS2_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["agree", "confidence", "evidence_quote"],
  properties: {
    agree: { type: "boolean" },
    confidence: { type: "number" },
    evidence_quote: { type: "string" },
  },
};

/** Run Pass 1 + Pass 2 for one call. Returns verified flags + total cost. */
export async function analyzeCall(input: {
  transcript: string;
  extracted: string;
  defs: ReviewFlagDef[];
  instructions: string | null;
}): Promise<{ flags: VerifiedFlag[]; cost: number }> {
  const usableDefs = rubricDefsForReview(
    input.defs,
    Boolean(input.instructions),
  );
  const rubric = buildRubricText(usableDefs);
  const validKeys = new Set(usableDefs.map((d) => d.key));

  const playbook = input.instructions
    ? `AGENT INSTRUCTIONS (the agent's playbook for this call):\n${input.instructions}\n\n` +
      `Using these instructions:\n` +
      `- Do NOT flag behavior the instructions explicitly call for — it's intended, not a defect.\n` +
      `- Propose the "${OFF_SCRIPT_KEY}" flag when the agent failed to follow a specific instruction, quoting the transcript moment.\n\n`
    : "";

  const p1 = await callOpenAiJson<{ flags: ProposedFlag[] }>({
    model: PASS1_MODEL,
    schemaName: "call_flags",
    schema: PASS1_SCHEMA,
    system:
      "You review a single sales/outreach phone call transcript between OUR AI agent and a business (the lead). " +
      "Flag ONLY things the transcript clearly supports, and quote the exact line as evidence. Never invent. " +
      "Attribution matters: the agent's pitch is NOT the lead's view.",
    user:
      playbook +
      `Rubric (flag_key (lens): meaning):\n${rubric}\n\n` +
      `Extracted call data: ${input.extracted}\n\n` +
      `Transcript:\n${input.transcript}\n\n` +
      "Return every rubric flag that applies, each with a verbatim evidence_quote from the transcript and a 0-1 confidence.",
    mock: { flags: [] },
  });
  const proposed = (p1.data?.flags ?? []).filter((f) =>
    validKeys.has(f.flag_key),
  );
  let cost = p1.cost;
  if (proposed.length === 0) return { flags: [], cost };

  const verdicts: Record<string, Verdict> = {};
  for (const f of proposed) {
    const def = input.defs.find((d) => d.key === f.flag_key);
    const p2 = await callOpenAiJson<Verdict>({
      model: PASS2_MODEL,
      schemaName: "flag_verdict",
      schema: PASS2_SCHEMA,
      system:
        "You are a strict verifier. Given a call transcript and a claimed flag, decide if the flag is genuinely " +
        "true FROM THE TRANSCRIPT. Default to agree=false when the evidence is weak or ambiguous.",
      user:
        (input.instructions
          ? `Agent's instructions (playbook): ${input.instructions.slice(0, 2000)}\n` +
            `A flag is INVALID if it describes behavior the instructions call for. ` +
            `"${OFF_SCRIPT_KEY}" is valid only if the agent genuinely failed to follow a specific instruction.\n\n`
          : "") +
        `Flag: ${f.flag_key} — ${def?.label}. Meaning: ${def?.guidance}\n` +
        `Claimed evidence: "${f.evidence_quote}"\n\n` +
        `Transcript:\n${input.transcript}\n\n` +
        "Is this flag genuinely true? Return agree (bool), confidence (0-1), and the correct verbatim evidence_quote.",
      mock: {
        agree: true,
        confidence: f.confidence,
        evidence_quote: f.evidence_quote,
      },
    });
    cost += p2.cost;
    if (p2.data) verdicts[f.flag_key] = p2.data;
  }

  return { flags: mergeVerification(proposed, verdicts), cost };
}
