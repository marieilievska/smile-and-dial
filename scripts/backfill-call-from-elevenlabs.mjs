// Backfill a call whose ElevenLabs `post_call_transcription` webhook never
// arrived, so duration / cost / transcript were never written.
//
//   node --experimental-strip-types --env-file=.env.local \
//     scripts/backfill-call-from-elevenlabs.mjs <callId> [--apply]
//
// Everything ElevenLabs would have PUSHED is PULLED from
// GET /v1/convai/conversations/{id} instead — the same inversion
// src/lib/elevenlabs/recording-fetch.ts already applies to call audio, for the
// same reason: the webhook has retries disabled, so one missed delivery is
// permanent. The dollar figures are computed by the app's OWN cost modules
// (imported, never retyped), so the row is priced exactly like every other call.
//
// Writes ONLY the fields the missing transcript event owns:
//   status, ended_at, duration_seconds, transcript_json, cost_breakdown
//
// It deliberately does NOT touch `outcome` / `outcome_source`: where those are
// already set they are correct, and an operator's `manual` stamp is the
// truthful record — ElevenLabs never delivered a classification to attribute
// this to. It also runs NO side effects (no retry engine, no callback rows, no
// DNC, no lead mutation), because the lead may hold a live callback that a
// replayed pipeline would disturb — the same reasoning that kept #505 from
// re-running the retry ladder.

import { register } from "node:module";

import { createClient } from "@supabase/supabase-js";

// The cost modules are Next.js server modules: their first line is
// `import "server-only"`, a package that only resolves inside a Next build.
// Stub it to an empty module so plain node can load the real pricing code
// rather than this script re-typing the rates it is supposed to reuse.
register(
  "data:text/javascript," +
    encodeURIComponent(
      "export async function resolve(specifier, context, next) {" +
        'if (specifier === "server-only") {' +
        'return { url: "data:text/javascript,", format: "module", shortCircuit: true };' +
        "}" +
        "return next(specifier, context);" +
        "}",
    ),
  import.meta.url,
);
register("./ts-path-alias.mjs", import.meta.url);

const {
  priceElevenLabsCredits,
  elevenLabsUsdPerCredit,
  priceElevenLabsNativeTwilio,
} = await import("../src/lib/costs/rates.ts");
const { numField, withRecomputedTotal } =
  await import("../src/lib/costs/breakdown.ts");
const { primeEffectiveRates } =
  await import("../src/lib/costs/effective-rates.ts");

const callId = process.argv[2];
const APPLY = process.argv.includes("--apply");
if (!callId) {
  console.error("usage: backfill-call-from-elevenlabs.mjs <callId> [--apply]");
  process.exit(1);
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const { data: call, error } = await supabase
  .from("calls")
  .select(
    "id, lead_id, direction, status, outcome, outcome_source, started_at, ended_at, duration_seconds, cost_breakdown, transcript_json, elevenlabs_conversation_id",
  )
  .eq("id", callId)
  .single();
if (error || !call) {
  console.error("call not found:", error?.message);
  process.exit(1);
}
if (!call.elevenlabs_conversation_id) {
  console.error("call has no elevenlabs_conversation_id — nothing to pull");
  process.exit(1);
}

const res = await fetch(
  `https://api.elevenlabs.io/v1/convai/conversations/${call.elevenlabs_conversation_id}`,
  { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY } },
);
if (!res.ok) {
  console.error("elevenlabs:", res.status, await res.text());
  process.exit(1);
}
const conv = await res.json();
// A conversation still in flight has no final duration or cost; refusing beats
// writing a half-priced row that nothing would ever correct.
if (conv.status !== "done") {
  console.error(
    `conversation status is "${conv.status}", not "done" — refusing`,
  );
  process.exit(1);
}
const durationSecs = conv.metadata?.call_duration_secs ?? 0;
if (!durationSecs) {
  console.error("conversation reports no call_duration_secs — refusing");
  process.exit(1);
}

// Price with the app's modules at the DB's effective rates (cost_rates), not
// the hard-coded defaults.
await primeEffectiveRates(supabase);
const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
const charging = conv.metadata?.charging;
const elRate = elevenLabsUsdPerCredit();
const elTotalCredits = num(conv.metadata?.cost);
const elLlmCredits = num(charging?.llm_charge);
const elVoiceCredits = num(charging?.call_charge);
const prevCost = call.cost_breakdown ?? {};
const twilioParts = priceElevenLabsNativeTwilio(durationSecs, call.direction);

const mergedCost = withRecomputedTotal({
  // Carry any prior keys (an in-call research charge, a lookup) — this backfill
  // owns the vendor figures it computes, not the whole object.
  ...prevCost,
  twilio: twilioParts.total,
  twilio_call: twilioParts.call,
  twilio_media_stream: twilioParts.mediaStream,
  elevenlabs: priceElevenLabsCredits(elTotalCredits),
  elevenlabs_llm: Number((elLlmCredits * elRate).toFixed(4)),
  elevenlabs_voice: Number((elVoiceCredits * elRate).toFixed(4)),
  elevenlabs_credits: elTotalCredits,
  elevenlabs_llm_credits: elLlmCredits,
  elevenlabs_voice_credits: elVoiceCredits,
  openai: numField(prevCost, "openai"),
  lookup: numField(prevCost, "lookup"),
});

// The real end time from ElevenLabs. The live webhook stamps `now()`, which is
// right when it fires seconds after the call; on a backfill it would be hours
// late. The row currently holds whatever the 15-minute stale-call reaper wrote.
const endedAt = conv.metadata?.start_time_unix_secs
  ? new Date(
      (conv.metadata.start_time_unix_secs + durationSecs) * 1000,
    ).toISOString()
  : call.ended_at;

const update = {
  status: "completed",
  ended_at: endedAt,
  duration_seconds: durationSecs,
  transcript_json: conv.transcript ?? null,
  cost_breakdown: mergedCost,
};

console.log("=== BEFORE ===");
console.log({
  status: call.status,
  outcome: call.outcome,
  outcome_source: call.outcome_source,
  ended_at: call.ended_at,
  duration_seconds: call.duration_seconds,
  cost_breakdown: call.cost_breakdown,
  transcript_turns: Array.isArray(call.transcript_json)
    ? call.transcript_json.length
    : null,
});
console.log("\n=== AFTER ===");
console.log({
  ...update,
  transcript_json: `${conv.transcript?.length ?? 0} turns`,
});
console.log("\n=== UNTOUCHED ===");
console.log(
  "outcome, outcome_source, lead row, callbacks, retry schedule, DNC",
);

if (!APPLY) {
  console.log("\nDRY RUN — re-run with --apply to write.");
  process.exit(0);
}

const { error: upErr } = await supabase
  .from("calls")
  .update(update)
  .eq("id", callId);
if (upErr) {
  console.error("update failed:", upErr.message);
  process.exit(1);
}

await supabase.from("system_events").insert({
  kind: "cost_backfill",
  actor_user_id: null,
  ref_table: "calls",
  ref_id: callId,
  payload: {
    reason:
      "ElevenLabs post_call_transcription webhook never delivered (only post_call_audio arrived); pulled from the conversations API",
    conversation_id: call.elevenlabs_conversation_id,
    duration_seconds: durationSecs,
    total_usd: mergedCost.total,
    status_from: call.status,
    status_to: "completed",
  },
});

console.log("\nAPPLIED.");
