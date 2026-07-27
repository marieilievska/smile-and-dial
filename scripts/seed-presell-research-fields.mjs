// Seed the HireAI Presell Research agent's two custom data-collection fields.
//
//   npm run seed:presell-fields
//
// Why this exists as a script and not just a database row: prod has been wiped
// more than once, and these two fields are the entire research payload of the
// campaign — losing them silently means calls keep dialling but stop capturing
// the only answers we're calling for. Re-running is safe and idempotent.
//
// It writes `agents.extra_data_collection` (the same slot the Settings → Agents
// "Data collection" editor writes) and then pushes the fields onto the
// connected ElevenLabs agent, exactly the way `applyConnectedAgentIntegration`
// does — additive merge, nothing else in platform_settings is touched.

import { pathToFileURL } from "node:url";

import {
  BASE_DATA_COLLECTION_IDS,
  toElevenLabsDataCollectionObject,
} from "../src/lib/agents/data-collection.ts";

/** The agent these fields belong to (override with --agent=<elevenlabs id>). */
const DEFAULT_EL_AGENT_ID = "agent_9201kyj4pczhft28cc144m0xqzeg";

/**
 * The two research fields, direction-neutral by design.
 *
 * The agent asks one question that matters ("would you ever consider having an
 * AI pick up your calls when there's nobody around?") and then digs for the WHY
 * behind whatever they answered. Both halves are worth just as much when the
 * answer is no, so neither field is named for a positive outcome — an earlier
 * pair called `interest_level` / `interest_reason` implied one, which made a
 * recorded "no" read like a missing value.
 *
 * `ai_answering_stance` doubles as the campaign's sentiment field: Reporting
 * auto-detects the custom field with a small value set and colours it, and Hot
 * Leads pulls the warm ones. That detection matches on the literal strings
 * "yes" / "maybe" / "no" (see POSITIVE/NEUTRAL/NEGATIVE in
 * src/lib/agent-analytics/field-detect.ts), so those values are load-bearing —
 * renaming them to anything else silently empties Voice of Customer and Hot
 * Leads. tests/presell-research-fields.unit.test.ts locks that down.
 */
export const PRESELL_RESEARCH_FIELDS = [
  {
    id: "ai_answering_stance",
    type: "string",
    enumValues: ["yes", "maybe", "no"],
    description:
      "Where the person landed on the one research question this call exists " +
      "to answer: would they consider letting an AI pick up their phone when " +
      "nobody's around — after hours, or when the desk is slammed. Use EXACTLY " +
      "one of: yes (they would consider it — open to it, curious, or they " +
      "already want something like it); maybe (genuinely undecided — " +
      "'depends', 'I'd have to see it', open only if some condition were met); " +
      "no (they would NOT consider it — they pushed back, said their customers " +
      "need to reach a real person, or otherwise rejected the idea). This " +
      "records WHERE THEY LANDED, not how good a prospect they are: a clear " +
      "'no' is a real and wanted answer, so record 'no' — never leave it blank " +
      "to avoid logging a negative. Leave blank ONLY when there is genuinely " +
      "no answer to record: the question was never asked, or they never landed " +
      "anywhere on it (voicemail, hung up in the first seconds, the gatekeeper " +
      "ended the call, or they deflected throughout).",
  },
  {
    id: "ai_answering_reason",
    type: "string",
    enumValues: [],
    description:
      "The REASON behind their answer to the AI-answering question, in " +
      "whichever direction they went. If they were positive: why they'd want " +
      "it (e.g. 'we lose a ton of calls at lunch', 'there's only one of me at " +
      "the desk'). If they were negative: why they wouldn't (e.g. 'people call " +
      "here to talk to us', 'it'd sound like a robot'). If they were " +
      "undecided: what would make it a yes, or what worries them. A reason for " +
      "saying NO is exactly as valuable as a reason for saying yes — capture " +
      "both the same way, and never leave this blank just because the answer " +
      "was negative. Record their actual reasoning as a short quote or close " +
      "paraphrase, not a label: \"we're small on purpose, people call to talk " +
      'to us" is right, "not interested" is wrong. Leave blank only if they ' +
      "gave no reason at all.",
  },
];

// Everything below only runs when this file is executed directly — the field
// definitions above are imported as plain data by the unit test.

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const elKey = process.env.ELEVENLABS_API_KEY;

const elAgentId =
  process.argv.find((a) => a.startsWith("--agent="))?.slice(8) ||
  DEFAULT_EL_AGENT_ID;

const sh = {
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  "Content-Type": "application/json",
};

function assertNoBaseCollision() {
  for (const f of PRESELL_RESEARCH_FIELDS) {
    if (BASE_DATA_COLLECTION_IDS.has(f.id)) {
      throw new Error(
        `"${f.id}" collides with a base data-collection field — the sync layer ` +
          "drops colliding ids, so it would never reach ElevenLabs.",
      );
    }
  }
}

async function seedAgentRow() {
  const rows = await (
    await fetch(
      `${url}/rest/v1/agents?elevenlabs_agent_id=eq.${encodeURIComponent(elAgentId)}` +
        "&select=id,name,extra_data_collection",
      { headers: sh },
    )
  ).json();

  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error(
      `Expected exactly 1 agent with elevenlabs_agent_id=${elAgentId}, found ${
        Array.isArray(rows) ? rows.length : "an error"
      }.`,
    );
  }

  const before = rows[0];
  console.log(`Agent: ${before.name} (${before.id})`);
  console.log(
    `  before: ${JSON.stringify(
      (before.extra_data_collection ?? []).map((f) => f?.id),
    )}`,
  );

  const res = await fetch(`${url}/rest/v1/agents?id=eq.${before.id}`, {
    method: "PATCH",
    headers: { ...sh, Prefer: "return=representation" },
    body: JSON.stringify({ extra_data_collection: PRESELL_RESEARCH_FIELDS }),
  });
  if (!res.ok) {
    throw new Error(`Agent update failed (${res.status}): ${await res.text()}`);
  }
  const [after] = await res.json();
  console.log(
    `  after:  ${JSON.stringify(
      (after.extra_data_collection ?? []).map((f) => f?.id),
    )}`,
  );
}

async function pushToElevenLabs() {
  if (!elKey) {
    console.log(
      "\nELEVENLABS_API_KEY not set — skipped the ElevenLabs push. Open " +
        "Settings → Agents and hit Sync to send the fields across.",
    );
    return;
  }

  const api = `https://api.elevenlabs.io/v1/convai/agents/${encodeURIComponent(elAgentId)}`;
  const res = await fetch(api, { headers: { "xi-api-key": elKey } });
  if (!res.ok) {
    throw new Error(`ElevenLabs lookup failed (${res.status}).`);
  }
  const current = await res.json();
  const ps = current.platform_settings ?? {};
  const existing =
    ps.data_collection && typeof ps.data_collection === "object"
      ? ps.data_collection
      : {};

  // Additive, exactly like applyConnectedAgentIntegration: the agent's own
  // ElevenLabs-built fields survive, ours are merged on top.
  const merged = {
    ...existing,
    ...toElevenLabsDataCollectionObject(PRESELL_RESEARCH_FIELDS),
  };

  const patch = await fetch(api, {
    method: "PATCH",
    headers: { "xi-api-key": elKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      platform_settings: { ...ps, data_collection: merged },
    }),
  });
  if (!patch.ok) {
    throw new Error(
      `ElevenLabs update failed (${patch.status}): ${await patch.text()}`,
    );
  }
  console.log(`\nElevenLabs "${current.name}" data collection:`);
  console.log(`  ${Object.keys(merged).join(", ")}`);
}

const isEntrypoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  if (!url || !serviceKey) {
    console.error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.",
    );
    process.exit(1);
  }
  assertNoBaseCollision();
  await seedAgentRow();
  await pushToElevenLabs();
  console.log("\nDone.");
}
