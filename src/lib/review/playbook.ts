import "server-only";
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { fetchElevenLabsAgentPrompt } from "@/lib/elevenlabs/agents";
import { callOpenAiJson, PASS2_MODEL } from "./openai";
import { INSTRUCTIONS_CAP, truncateInstructions } from "./instructions";

type Admin = ReturnType<typeof createClient<Database>>;

/** Upper bound on checklist size. Real playbooks land around 15-18 genuinely
 *  distinct requirements; capping below that made the model silently drop rules
 *  and pick a different tail on each derivation, so the checklist looked
 *  unstable. This is a backstop against a runaway list, not a target. */
export const MAX_STEPS = 20;

/** One checkable requirement pulled out of an agent's own system prompt. */
export type PlaybookStep = {
  /** Stable slug, used as the step identity in stored findings. */
  key: string;
  /** Short human label, shown in the UI. */
  title: string;
  /**
   * true  — the prompt demands this happen a specific way (compliance lines,
   *         tool calls, disclosures). Skipping or improvising it is a defect.
   * false — the prompt fixes the INTENT but deliberately leaves the wording
   *         free. Saying it in different words is CORRECT; only never doing it
   *         at all counts. This distinction is the whole point of the file:
   *         conflating the two is what produced the bogus off-script flags.
   */
  rigid: boolean;
  /** What the agent must actually do, phrased so it can be checked. */
  requirement: string;
  /** The situation this step applies to, so the reviewer doesn't fault a call
   *  for skipping a step that never became relevant. */
  applies_when: string;
};

export type AgentPlaybook = {
  steps: PlaybookStep[];
  /** The prompt the steps were derived from — what the reviewer quotes against. */
  prompt: string;
};

const DERIVE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["steps"],
  properties: {
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "title", "rigid", "requirement", "applies_when"],
        properties: {
          key: { type: "string" },
          title: { type: "string" },
          rigid: { type: "boolean" },
          requirement: { type: "string" },
          applies_when: { type: "string" },
        },
      },
    },
  },
};

const DERIVE_SYSTEM =
  "You turn a voice AI agent's system prompt into a short review checklist. " +
  "You are NOT judging a call — you are listing what this particular agent is required to do, " +
  "so a reviewer can later check a transcript against it.";

const DERIVE_USER_SUFFIX =
  `Extract at most ${MAX_STEPS} required steps, most important first.\n\n` +
  "Rules:\n" +
  "- Only include steps that can be checked from a TEXT TRANSCRIPT alone. Skip anything needing " +
  "audio, timing, or tool logs (tone of voice, pauses, latency, whether a tool errored).\n" +
  "- Set rigid=true ONLY when the prompt requires specific wording or a specific action: legal or " +
  "compliance disclosures, naming itself as AI, a named tool call, a required confirmation.\n" +
  "- Set rigid=false when the prompt fixes what the step ACHIEVES but leaves the wording open. " +
  "Most prompts include sample lines purely as calibration and say so explicitly — those are " +
  "examples, never required phrasing. For a rigid=false step, only NEVER DOING IT counts as a " +
  "miss; different wording is correct and must not be treated as a deviation.\n" +
  "- Do NOT create steps for HOW the agent talks — tone, personality, pacing, filler words, " +
  "sounding natural, re-asking something already answered, repeating itself, monologuing, or " +
  "talking over people. Every agent is graded on those separately; repeating them here would " +
  "flag the same fault twice. Only include steps about WHAT this agent must do or cover.\n" +
  "- applies_when must name the concrete situation ('every call', 'when a gatekeeper answers', " +
  "'only once the owner is on the line'), so a call that never reached that situation is not faulted.\n" +
  "- requirement must be specific enough that two reviewers would agree whether it happened.\n" +
  "- key: lower_snake_case, unique, stable and descriptive (e.g. intro_states_ai).";

/** Normalise a model-proposed key into a stable slug. */
function slugify(raw: string, index: number): string {
  const s = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return s || `step_${index + 1}`;
}

/** Drop malformed/duplicate steps and cap the list. Pure — unit tested. */
export function normalizeSteps(raw: PlaybookStep[]): PlaybookStep[] {
  const seen = new Set<string>();
  const out: PlaybookStep[] = [];
  for (const [i, s] of raw.entries()) {
    if (
      !s ||
      typeof s.title !== "string" ||
      typeof s.requirement !== "string"
    ) {
      continue;
    }
    const title = s.title.trim();
    const requirement = s.requirement.trim();
    if (!title || !requirement) continue;
    let key = slugify(typeof s.key === "string" ? s.key : title, i);
    if (seen.has(key)) key = `${key}_${i + 1}`;
    seen.add(key);
    out.push({
      key,
      title,
      rigid: s.rigid === true,
      requirement,
      applies_when:
        typeof s.applies_when === "string" && s.applies_when.trim()
          ? s.applies_when.trim()
          : "every call",
    });
    if (out.length >= MAX_STEPS) break;
  }
  return out;
}

/** Derive the checklist for one prompt. Returns [] when the model is unavailable. */
export async function derivePlaybookSteps(
  prompt: string,
): Promise<{ steps: PlaybookStep[]; cost: number }> {
  const res = await callOpenAiJson<{ steps: PlaybookStep[] }>({
    model: PASS2_MODEL,
    schemaName: "agent_playbook",
    schema: DERIVE_SCHEMA,
    system: DERIVE_SYSTEM,
    user: `AGENT SYSTEM PROMPT:\n${prompt}\n\n${DERIVE_USER_SUFFIX}`,
    mock: { steps: [] },
  });
  return {
    steps: normalizeSteps(res.data?.steps ?? []),
    cost: res.cost,
  };
}

/** sha256 of the prompt the checklist was derived from. */
export function promptHash(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

/** The agent's current instructions: local prompt for wizard agents, the live
 *  ElevenLabs prompt for externally-managed ones (falling back to the cached
 *  copy only if ElevenLabs is unreachable). Refetched every time rather than
 *  weekly — an edited prompt used to take up to 7 days to reach the reviewer. */
export async function resolveAgentPrompt(
  admin: Admin,
  agentId: string | null,
): Promise<string | null> {
  if (!agentId) return null;
  const { data: agent } = await admin
    .from("agents")
    .select(
      "system_prompt, externally_managed, elevenlabs_agent_id, review_prompt",
    )
    .eq("id", agentId)
    .maybeSingle();
  if (!agent) return null;

  if (!agent.externally_managed) {
    return truncateInstructions(
      agent.system_prompt?.trim() || null,
      INSTRUCTIONS_CAP,
    );
  }
  if (!agent.elevenlabs_agent_id) {
    return truncateInstructions(agent.review_prompt ?? null, INSTRUCTIONS_CAP);
  }
  const fetched = await fetchElevenLabsAgentPrompt(agent.elevenlabs_agent_id);
  if (!fetched) {
    return truncateInstructions(agent.review_prompt ?? null, INSTRUCTIONS_CAP);
  }
  await admin
    .from("agents")
    .update({
      review_prompt: fetched,
      review_prompt_at: new Date().toISOString(),
    })
    .eq("id", agentId);
  return truncateInstructions(fetched, INSTRUCTIONS_CAP);
}

/**
 * The checklist to grade this agent's calls against. Reuses the cached
 * checklist while the prompt is unchanged; re-derives the moment it differs.
 * Returns null when there's no prompt to derive from — the caller then reviews
 * delivery only, rather than inventing a playbook it doesn't have.
 */
export async function resolveAgentPlaybook(
  admin: Admin,
  agentId: string | null,
  opts: { force?: boolean } = {},
): Promise<{ playbook: AgentPlaybook | null; cost: number }> {
  const prompt = await resolveAgentPrompt(admin, agentId);
  if (!prompt || !agentId) return { playbook: null, cost: 0 };

  const hash = promptHash(prompt);
  const { data: agent } = await admin
    .from("agents")
    .select("review_playbook, review_playbook_hash")
    .eq("id", agentId)
    .maybeSingle();

  const cached = agent?.review_playbook as PlaybookStep[] | null | undefined;
  if (
    !opts.force &&
    agent?.review_playbook_hash === hash &&
    Array.isArray(cached) &&
    cached.length
  ) {
    return { playbook: { steps: cached, prompt }, cost: 0 };
  }

  const { steps, cost } = await derivePlaybookSteps(prompt);
  if (steps.length === 0) {
    // Derivation failed (model down / empty result). Fall back to a stale
    // checklist if we have one rather than reviewing against nothing.
    return {
      playbook:
        Array.isArray(cached) && cached.length
          ? { steps: cached, prompt }
          : null,
      cost,
    };
  }
  await admin
    .from("agents")
    .update({
      review_playbook:
        steps as unknown as Database["public"]["Tables"]["agents"]["Update"]["review_playbook"],
      review_playbook_hash: hash,
      review_playbook_at: new Date().toISOString(),
    })
    .eq("id", agentId);
  return { playbook: { steps, prompt }, cost };
}
