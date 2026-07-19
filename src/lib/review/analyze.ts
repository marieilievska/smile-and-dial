import "server-only";
import { callOpenAiJson, PASS1_MODEL, PASS2_MODEL } from "./openai";
import type { ProposedFinding, ReviewFlagDef, VerifiedFinding } from "./types";
import type { PlaybookStep } from "./playbook";
import {
  buildPass1User,
  buildPass2User,
  PASS1_SYSTEM,
  PASS2_SYSTEM,
  PLAYBOOK_MISSED_KEY,
  type RejectedExample,
} from "./prompts";

const CONFIDENCE_FLOOR = 0.6; // below this (or on disagreement) -> needs_review

type Verdict = { agree: boolean; confidence: number; evidence_quote: string };

/** Identity of a finding: a playbook miss is per-step, everything else per-flag. */
export function findingId(flagKey: string, stepKey: string | null): string {
  return stepKey ? `${flagKey}:${stepKey}` : flagKey;
}

/** Deterministic merge of Pass 1 proposals + Pass 2 verdicts. Pure — unit tested. */
export function mergeVerification(
  proposed: ProposedFinding[],
  verdicts: Record<string, Verdict>,
): VerifiedFinding[] {
  const out: VerifiedFinding[] = [];
  for (const p of proposed) {
    const v = verdicts[findingId(p.flag_key, p.step_key)];
    if (!v) {
      out.push({ ...p, status: "needs_review" });
      continue;
    }
    if (!v.agree) continue; // refuted -> drop
    const confidence = Math.min(p.confidence, v.confidence);
    out.push({
      flag_key: p.flag_key,
      step_key: p.step_key,
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
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["flag_key", "step_key", "evidence_quote", "confidence"],
        properties: {
          flag_key: { type: "string" },
          step_key: { type: "string" },
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

/**
 * Run Pass 1 + Pass 2 for one call.
 *
 * Pass 1 proposes findings against two things: the agent's OWN playbook
 * (derived per agent, so this works for any prompt) and a fixed set of delivery
 * checks that apply to every agent. Pass 2 re-checks each finding on its own and
 * drops the ones it can't stand behind.
 */
export async function analyzeCall(input: {
  transcript: string;
  extracted: string;
  defs: ReviewFlagDef[];
  steps: PlaybookStep[];
  rejected: RejectedExample[];
}): Promise<{ findings: VerifiedFinding[]; cost: number }> {
  const validKeys = new Set(input.defs.map((d) => d.key));
  const stepByKey = new Map(input.steps.map((s) => [s.key, s]));

  const p1 = await callOpenAiJson<{ findings: ProposedFinding[] }>({
    model: PASS1_MODEL,
    schemaName: "call_findings",
    schema: PASS1_SCHEMA,
    system: PASS1_SYSTEM,
    user: buildPass1User({
      steps: input.steps,
      defs: input.defs,
      extracted: input.extracted,
      transcript: input.transcript,
      rejected: input.rejected,
    }),
    mock: { findings: [] },
  });

  // Normalise: keep known flags only, and only keep step_key when it names a
  // step this agent actually has (the model occasionally invents one).
  const seen = new Set<string>();
  const proposed: ProposedFinding[] = [];
  for (const f of p1.data?.findings ?? []) {
    if (!validKeys.has(f.flag_key)) continue;
    const stepKey =
      f.flag_key === PLAYBOOK_MISSED_KEY &&
      typeof f.step_key === "string" &&
      stepByKey.has(f.step_key)
        ? f.step_key
        : null;
    // A playbook miss with no resolvable step is unactionable — drop it rather
    // than store "something was skipped" with nothing to point at.
    if (f.flag_key === PLAYBOOK_MISSED_KEY && !stepKey) continue;
    const id = findingId(f.flag_key, stepKey);
    if (seen.has(id)) continue;
    seen.add(id);
    proposed.push({ ...f, step_key: stepKey });
  }

  let cost = p1.cost;
  if (proposed.length === 0) return { findings: [], cost };

  const verdicts: Record<string, Verdict> = {};
  for (const f of proposed) {
    const def = input.defs.find((d) => d.key === f.flag_key);
    const step = f.step_key ? (stepByKey.get(f.step_key) ?? null) : null;
    const p2 = await callOpenAiJson<Verdict>({
      model: PASS2_MODEL,
      schemaName: "flag_verdict",
      schema: PASS2_SCHEMA,
      system: PASS2_SYSTEM,
      user: buildPass2User({
        meaning: `${def?.label ?? f.flag_key}. ${def?.guidance ?? ""}`,
        evidenceQuote: f.evidence_quote,
        transcript: input.transcript,
        step,
      }),
      mock: {
        agree: true,
        confidence: f.confidence,
        evidence_quote: f.evidence_quote,
      },
    });
    cost += p2.cost;
    if (p2.data) verdicts[findingId(f.flag_key, f.step_key)] = p2.data;
  }

  return { findings: mergeVerification(proposed, verdicts), cost };
}
