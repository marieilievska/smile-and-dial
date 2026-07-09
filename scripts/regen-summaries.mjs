// One-off backfill: regenerate every lead-with-calls' rolling ai_summary using
// the NEW summary prompt (matches src/lib/openai/summary-merger.ts after
// PR #143), so existing leads surface the prospect's main struggle too.
// Rebuilds from scratch by replaying each lead's call summaries in order.
// Run: node scripts/regen-summaries.mjs   (add --write to persist; default = dry run)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRITE = process.argv.includes("--write");

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
const sh = { apikey: SKEY, Authorization: `Bearer ${SKEY}` };

const SYSTEM_PROMPT =
  "You maintain a short, factual running context note about a sales " +
  "lead, written for the next cold-caller who will phone them. " +
  "Attribution is critical: every call is between OUR agent (e.g. " +
  "'Jack from Referrizer') and the lead (the business we're calling). " +
  "The agent's pitch, questions, and talking points are NOT the " +
  "lead's views. Never write that the lead wants, likes, is " +
  "interested in, or agreed to something unless the LEAD clearly " +
  "said so themselves. If the agent asked a question the lead didn't " +
  "answer, the lead's position is still unknown — say that. Do not " +
  "infer interest from the fact that the agent made a pitch. When in " +
  "doubt, under-claim.";

function userPrompt(existing, latest) {
  return `Existing note about this lead:
${existing || "(none yet)"}

Newest call summary:
${latest}

Rewrite the running note so the NEXT caller knows what happened and what to do.
Capture, factually and in PAST tense (these calls already happened):
- Who/what we know about the lead (their name or role IF they gave it, business
  specifics, hours).
- What actually happened on the last call and what the LEAD themselves said —
  their questions, objections, or stated interest/disinterest. If the lead
  didn't really engage (put us on hold, hung up, went to voicemail, or we only
  reached a gatekeeper), say plainly what blocked us.
- The lead's main challenge or pain point IN THEIR OWN BUSINESS — what they
  said they struggle with (e.g. no-shows, slow seasons, staffing, getting
  reviews, retaining members) — but ONLY if the LEAD themselves raised it. If
  they mentioned no problem, leave it out; never guess one.
- A commitment ONLY if the lead explicitly agreed to one (a callback time,
  permission to send info). If none, say no commitment was made.
- What the next caller should DO or open with, given how this went.

Do NOT restate the agent's pitch or questions as the lead's interest. Do NOT
invent details. Do NOT include dates or "X ago" timing — the caller is told
separately how long ago the last call was.

Write 2–5 short sentences in this shape:
"We know X (include their main struggle if they shared one). Last call: Y.
Next time: Z."
Max 200 words. No filler.`;
}

async function callOpenAi(existing, latest) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt(existing, latest) },
      ],
      max_tokens: 400,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content ?? "").trim();
}

// All calls with a summary, oldest first, grouped by lead.
const calls = await (
  await fetch(
    `${SUPA}/rest/v1/calls?select=lead_id,summary,created_at&summary=not.is.null&order=created_at`,
    { headers: sh },
  )
).json();
const byLead = new Map();
for (const c of calls) {
  if (!c.summary) continue;
  (byLead.get(c.lead_id) ?? byLead.set(c.lead_id, []).get(c.lead_id)).push(
    c.summary,
  );
}

console.log(
  `${byLead.size} leads with calls. ${WRITE ? "WRITING." : "DRY RUN (use --write)."}\n`,
);

for (const [leadId, summaries] of byLead) {
  const lead = (
    await (
      await fetch(
        `${SUPA}/rest/v1/leads?select=company,ai_summary&id=eq.${leadId}`,
        { headers: sh },
      )
    ).json()
  )[0];
  // Replay the lead's calls in order to rebuild the rolling note from scratch.
  let note = "";
  for (const s of summaries) note = await callOpenAi(note, s);

  console.log(`### ${lead?.company ?? leadId}`);
  console.log(`OLD: ${lead?.ai_summary ?? "(none)"}`);
  console.log(`NEW: ${note}\n`);

  if (WRITE) {
    const r = await fetch(`${SUPA}/rest/v1/leads?id=eq.${leadId}`, {
      method: "PATCH",
      headers: {
        ...sh,
        "content-type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ ai_summary: note }),
    });
    if (!r.ok) console.log(`  ! write failed: ${r.status} ${await r.text()}`);
  }
}
console.log("Done.");
