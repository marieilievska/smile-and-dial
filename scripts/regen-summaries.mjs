// One-off backfill: rebuild every business's rolling per-campaign summary
// (lead_campaign_summaries.ai_summary) AND each connected call's pickup note
// (calls.callback_notes) from the full call TRANSCRIPT, using the new prompt.
//
// Keep the SYSTEM_PROMPT / buildUserPrompt / schema below in sync with
// src/lib/openai/summary-merger.ts — this script deliberately duplicates them so
// it can run as plain node against .env.local (no build step / path aliases).
//
// Modes (safe by default — the bare command SPENDS NOTHING):
//   node scripts/regen-summaries.mjs             PLAN  → counts + $ estimate, no OpenAI, no writes
//   node scripts/regen-summaries.mjs --sample=5  SAMPLE→ generate 5 businesses as examples, no writes
//   node scripts/regen-summaries.mjs --write     WRITE → generate everything AND persist (metered cost)
//
// Reads NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY
// from .env.local. Groups by (lead, campaign) and replays each group's connected
// calls oldest→newest, exactly like the live post-call path.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRITE = process.argv.includes("--write");
const sampleArg = process.argv.find((a) => a.startsWith("--sample="));
const SAMPLE = sampleArg
  ? Math.max(0, Number(sampleArg.split("=")[1]) || 0)
  : 0;
const PLAN = !WRITE && !SAMPLE;

const env = {};
for (const line of readFileSync(join(ROOT, ".env.local"), "utf8").split(
  /\r?\n/,
)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m) env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
}
const SUPA = env.NEXT_PUBLIC_SUPABASE_URL;
const SKEY = env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI = env.OPENAI_API_KEY;
const MODEL = env.SUMMARY_MODEL || "gpt-5.4-mini";
const sh = { apikey: SKEY, Authorization: `Bearer ${SKEY}` };

// The app prices ALL OpenAI usage at the gpt-4o-mini rate (see costs/rates.ts),
// so the estimate and the recorded cost use the same basis.
const IN_PER_1M = Number(env.OPENAI_GPT4OMINI_USD_PER_1M_INPUT || 0.15);
const OUT_PER_1M = Number(env.OPENAI_GPT4OMINI_USD_PER_1M_OUTPUT || 0.6);

// ---- Prompt (kept in sync with src/lib/openai/summary-merger.ts) ----
const SYSTEM_PROMPT =
  "You maintain a short, factual running memory about a business our team is " +
  "phoning, for whoever calls them next. Every call is between OUR agent and " +
  "the business (the lead). The agent's pitch, questions, and talking points " +
  "are NOT the lead's views — never write that the lead wants, likes, is " +
  "interested in, or agreed to something unless the LEAD clearly said so. If " +
  "the agent asked something the lead didn't answer, the lead's position is " +
  "still unknown — say so. Never invent names, roles, numbers, prices, or " +
  "claims that aren't in the transcript. Write in past tense (these calls " +
  "already happened). Do NOT tell the next caller what to do — record the " +
  "facts and let them decide. When in doubt, under-claim.";

const SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["rolling_summary", "callback_notes"],
  properties: {
    rolling_summary: { type: "string" },
    callback_notes: { type: "string" },
  },
};

function buildUserPrompt({ existing, transcript, latest, company, contacts }) {
  const companyLine = company
    ? `Business we're calling: "${company}". Use THIS name; if the transcript shows a different business name it was mis-heard on the call — ignore it and use "${company}".`
    : "";
  const contactsLine = contacts ? `Contacts already on file: ${contacts}.` : "";
  const source = transcript
    ? `Transcript of the latest call:\n${transcript}`
    : `Latest call recap:\n${latest}`;

  return `${companyLine}
${contactsLine}

Running memory so far (from earlier calls):
${existing || "(none yet)"}

${source}

Update the running memory and write a pickup note. Return JSON with two string fields:

"rolling_summary" — the factual running memory for whoever calls this business next. Capture, in past tense, ONLY what the transcript / known facts support:
- WHO we reached and their ROLE — owner / office manager / front desk / receptionist / unclear — named if given.
- The REAL decision-gateway: who actually decides, or who handles new leads, even when that's NOT the owner (e.g. "owner never on-site; front-desk manager Jane handles leads"). State reachability as facts — who we can and can't reach, and the best contact or email.
- What the LEAD actually said — their questions, objections, or stated interest/disinterest. If they didn't engage (put us on hold, hung up, went to voicemail, or we only reached a gatekeeper), say plainly what blocked us.
- The lead's own pain point ONLY if the LEAD raised it. Never guess one.
- A commitment ONLY if the lead explicitly agreed to one (a callback time, permission to send info). If none, say no commitment was made.
- Finish with a line starting "Already answered — don't re-ask:" listing everything the lead has already told us across all calls, so the next caller never re-interrogates them. Common items: how fast they follow up on new leads or missed calls (the "anchor" question our agent opens with), what scheduling / CRM software they use, whether the owner will take a call, and who handles leads. Omit this line only if nothing has been answered yet.

"callback_notes" — a SHORT pickup note (1–2 sentences) for the next caller, ONLY if this call left a concrete place to pick up: a promised callback, permission to send info, or "call back after 5 to reach the owner". Say what was agreed and where we left off, and remind not to re-ask what's already answered. If there is no concrete pickup point, return an empty string.

Do NOT invent details. Do NOT include dates or "X days ago" timing — the caller is told separately how long ago the last call was. No filler. Keep "rolling_summary" under ~180 words.`;
}

/** Same "Agent:/Lead:" formatting the app uses. */
function transcriptToText(raw) {
  const turns = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray(raw.transcript)
      ? raw.transcript
      : [];
  return turns
    .map((t) => {
      const role = t?.role === "user" ? "Lead" : "Agent";
      const msg =
        typeof t?.message === "string"
          ? t.message
          : typeof t?.text === "string"
            ? t.text
            : "";
      return msg ? `${role}: ${msg}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

let totalCost = 0;
async function generate({ existing, transcript, latest, company, contacts }) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: buildUserPrompt({
            existing,
            transcript,
            latest,
            company,
            contacts,
          }),
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "call_context",
          strict: true,
          schema: SUMMARY_SCHEMA,
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const usage = data.usage ?? {};
  totalCost +=
    ((usage.prompt_tokens ?? 0) / 1e6) * IN_PER_1M +
    ((usage.completion_tokens ?? 0) / 1e6) * OUT_PER_1M;
  const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}");
  return {
    rolling: (parsed.rolling_summary ?? "").trim(),
    callback: (parsed.callback_notes ?? "").trim(),
  };
}

// ---- Load every connected call (summary set = a human was reached), with its
// transcript, paginated past PostgREST's 1000-row cap. ----
async function loadConnectedCalls() {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const url =
      `${SUPA}/rest/v1/calls?select=id,lead_id,campaign_id,summary,transcript_json,created_at` +
      `&summary=not.is.null&campaign_id=not.is.null&order=created_at.asc&limit=1000&offset=${offset}`;
    const page = await (await fetch(url, { headers: sh })).json();
    if (!Array.isArray(page) || page.length === 0) break;
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}

const calls = await loadConnectedCalls();
const groups = new Map(); // "leadId|campaignId" -> [calls...]
for (const c of calls) {
  const key = `${c.lead_id}|${c.campaign_id}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(c);
}

// Estimate token cost without calling OpenAI: input ≈ transcript+prompt, out ≈ 300.
let estIn = 0;
let estOut = 0;
for (const c of calls) {
  const text = transcriptToText(c.transcript_json) || c.summary || "";
  estIn += Math.ceil(text.length / 4) + 900; // + prompt overhead + prior note
  estOut += 300;
}
const estCost = (estIn / 1e6) * IN_PER_1M + (estOut / 1e6) * OUT_PER_1M;

console.log(
  `\nBackfill plan (model ${MODEL}):\n` +
    `  businesses (lead × campaign): ${groups.size}\n` +
    `  connected calls to replay:    ${calls.length}\n` +
    `  estimated OpenAI cost:        ~$${estCost.toFixed(2)}  (est. ${(estIn / 1e6).toFixed(2)}M in / ${(estOut / 1e6).toFixed(2)}M out, gpt-4o-mini-rate basis)\n`,
);

if (PLAN) {
  console.log("PLAN mode — nothing generated or written. Re-run with:");
  console.log("  --sample=5   to preview 5 businesses (small spend)");
  console.log("  --write      to generate everything and persist.\n");
  process.exit(0);
}

// ---- SAMPLE / WRITE: replay each group oldest→newest. ----
const leadCache = new Map();
async function leadInfo(leadId) {
  if (leadCache.has(leadId)) return leadCache.get(leadId);
  const row = (
    await (
      await fetch(
        `${SUPA}/rest/v1/leads?select=company,owner_name,manager_name,employee_name&id=eq.${leadId}`,
        { headers: sh },
      )
    ).json()
  )[0];
  leadCache.set(leadId, row);
  return row;
}

let done = 0;
for (const [key, groupCalls] of groups) {
  if (SAMPLE && done >= SAMPLE) break;
  const [leadId, campaignId] = key.split("|");
  const lead = (await leadInfo(leadId)) ?? {};
  const contacts = [
    lead.owner_name && `owner ${lead.owner_name}`,
    lead.manager_name && `manager ${lead.manager_name}`,
    lead.employee_name && `staff ${lead.employee_name}`,
  ]
    .filter(Boolean)
    .join(", ");

  const oldRow = (
    await (
      await fetch(
        `${SUPA}/rest/v1/lead_campaign_summaries?select=ai_summary&lead_id=eq.${leadId}&campaign_id=eq.${campaignId}`,
        { headers: sh },
      )
    ).json()
  )[0];

  let note = "";
  const callbackByCall = [];
  for (const c of groupCalls) {
    const transcript = transcriptToText(c.transcript_json);
    const { rolling, callback } = await generate({
      existing: note,
      transcript,
      latest: c.summary || "",
      company: (lead.company || "").trim(),
      contacts,
    });
    note = rolling || note;
    callbackByCall.push({ id: c.id, callback });
  }

  console.log(`\n### ${lead.company ?? key}  (${groupCalls.length} calls)`);
  console.log(`OLD: ${oldRow?.ai_summary ?? "(none)"}`);
  console.log(`NEW: ${note}`);
  const lastCb = callbackByCall[callbackByCall.length - 1]?.callback;
  if (lastCb) console.log(`CALLBACK (last call): ${lastCb}`);

  if (WRITE) {
    // Rolling note (upsert on the unique lead_id,campaign_id).
    const up = await fetch(
      `${SUPA}/rest/v1/lead_campaign_summaries?on_conflict=lead_id,campaign_id`,
      {
        method: "POST",
        headers: {
          ...sh,
          "content-type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify({
          lead_id: leadId,
          campaign_id: campaignId,
          ai_summary: note,
          updated_at: new Date().toISOString(),
        }),
      },
    );
    if (!up.ok)
      console.log(`  ! summary write failed: ${up.status} ${await up.text()}`);
    // Per-call pickup notes.
    for (const { id, callback } of callbackByCall) {
      const r = await fetch(`${SUPA}/rest/v1/calls?id=eq.${id}`, {
        method: "PATCH",
        headers: {
          ...sh,
          "content-type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ callback_notes: callback || null }),
      });
      if (!r.ok) console.log(`  ! callback write failed (${id}): ${r.status}`);
    }
  }
  done++;
}

console.log(
  `\n${WRITE ? "WROTE" : "PREVIEWED"} ${done} businesses. Metered OpenAI cost so far: $${totalCost.toFixed(2)}.`,
);
console.log("Done.\n");
