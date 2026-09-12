// Read-only scoreboard for in-call tool latency: ElevenLabs' own per-tool
// timing next to the per-step timings our webhook records.
//
//   npm run report:tool-latency -- --since 2026-09-10 [--until 2026-09-13]
//
// ElevenLabs reports one number per tool call (`tool_latency_secs` on each
// transcript tool_result). That is the caller's actual wait. Our own
// `timings` (system_events payload, added 2026-09-12) split that wait into
// our database, Calendly, and the rest. Reading them together is the only way
// to tell "our server is slow" from "we are waiting on Calendly".
//
// Async tools (execution_mode "async" in the ElevenLabs dashboard) report
// latency 0 with an "in_progress" placeholder result — the agent never waits
// for them — so they are counted separately and excluded from the percentiles.
import process from "node:process";

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EL_KEY = process.env.ELEVENLABS_API_KEY;
if (!SUPABASE_URL || !SERVICE_KEY || !EL_KEY) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or ELEVENLABS_API_KEY. Run via `npm run report:tool-latency`, which loads .env.local.",
  );
  process.exit(1);
}

const since = arg("since");
if (!since) {
  console.error(
    "Usage: npm run report:tool-latency -- --since YYYY-MM-DD [--until YYYY-MM-DD]",
  );
  process.exit(1);
}
const until = arg("until");
const sinceIso = new Date(`${since}T00:00:00Z`).toISOString();
const untilIso = until ? new Date(`${until}T00:00:00Z`).toISOString() : null;

const sb = async (path) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
};

// 1. Our own tool audit rows in the window (and their step timings).
const events = [];
for (let offset = 0; ; offset += 1000) {
  const range =
    `created_at=gte.${sinceIso}` +
    (untilIso ? `&created_at=lt.${untilIso}` : "");
  const page = await sb(
    `system_events?select=kind,ref_id,created_at,payload&kind=like.tool_*&${range}` +
      `&order=created_at.desc,id.desc&limit=1000&offset=${offset}`,
  );
  events.push(...page);
  if (page.length < 1000) break;
}
const toolEvents = events.filter((e) => !e.kind.endsWith("_not_configured"));

// 2. Their calls' ElevenLabs conversation ids.
const callIds = [...new Set(toolEvents.map((e) => e.ref_id).filter(Boolean))];
const convByCall = new Map();
for (let i = 0; i < callIds.length; i += 100) {
  const chunk = callIds.slice(i, i + 100);
  for (const c of await sb(
    `calls?select=id,elevenlabs_conversation_id&id=in.(${chunk.join(",")})`,
  )) {
    if (c.elevenlabs_conversation_id) {
      convByCall.set(c.id, c.elevenlabs_conversation_id);
    }
  }
}

// 3. ElevenLabs' own per-tool timing for those conversations.
const conversations = [...new Set([...convByCall.values()])];
const samples = [];
let fetched = 0;
async function worker(queue) {
  while (queue.length) {
    const id = queue.shift();
    try {
      const res = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversations/${id}`,
        { headers: { "xi-api-key": EL_KEY } },
      );
      if (!res.ok) continue;
      const conv = await res.json();
      const startedAt = conv.metadata?.start_time_unix_secs ?? 0;
      for (const turn of conv.transcript ?? []) {
        for (const result of turn.tool_results ?? []) {
          if (result.type !== "webhook") continue;
          samples.push({
            tool: String(result.tool_name ?? "").replace(/^smiledial_/, ""),
            latency: result.tool_latency_secs ?? 0,
            async: /"status":\s*"in_progress"/.test(
              String(result.result_value ?? ""),
            ),
            at: (startedAt + (turn.time_in_call_secs ?? 0)) * 1000,
          });
        }
      }
    } catch {
      // one unreadable conversation must not sink the report
    } finally {
      fetched++;
    }
  }
}
const queue = [...conversations];
await Promise.all(Array.from({ length: 6 }, () => worker(queue)));

// ---------------------------------------------------------------------------
const q = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1)))
  ];
};
const fmt = (v, unit = "s") =>
  v == null ? "   -  " : `${v.toFixed(2)}${unit}`;

console.log(
  `\nWindow: ${since} → ${until ?? "now"} · ${toolEvents.length} tool audit rows · ${fetched}/${conversations.length} conversations read\n`,
);

console.log("What the caller waited for (ElevenLabs' own timing)");
console.log(
  "tool                      n     p50     p75     p90     max   | background",
);
const byTool = new Map();
for (const s of samples) {
  if (!byTool.has(s.tool)) byTool.set(s.tool, { sync: [], async: 0 });
  const bucket = byTool.get(s.tool);
  if (s.async) bucket.async++;
  else bucket.sync.push(s.latency);
}
for (const [tool, bucket] of [...byTool].sort(
  (a, b) => b[1].sync.length - a[1].sync.length,
)) {
  const l = bucket.sync;
  console.log(
    `${tool.padEnd(24)} ${String(l.length).padStart(3)}  ${fmt(q(l, 0.5))}  ${fmt(q(l, 0.75))}  ${fmt(q(l, 0.9))}  ${fmt(l.length ? Math.max(...l) : null)}  | ${bucket.async}`,
  );
}

console.log("\nTop of the hour vs the rest (synchronous tools only)");
const buckets = { ":00-:02": [], rest: [] };
for (const s of samples) {
  if (s.async) continue;
  const minute = new Date(s.at).getUTCMinutes();
  buckets[minute <= 2 ? ":00-:02" : "rest"].push(s.latency);
}
for (const [name, values] of Object.entries(buckets)) {
  console.log(
    `${name.padEnd(10)} n=${String(values.length).padStart(4)}  p50=${fmt(q(values, 0.5))}  p90=${fmt(q(values, 0.9))}`,
  );
}

console.log("\nWhere our own server time went (our timings, median ms)");
console.log(
  "tool                      n   total  context  calendly_avail  calendly_cfg  calendly_book",
);
const serverByKind = new Map();
for (const e of toolEvents) {
  const t = e.payload?.timings;
  if (!t) continue;
  const kind = e.kind.replace(/^tool_/, "");
  if (!serverByKind.has(kind)) serverByKind.set(kind, []);
  serverByKind.get(kind).push(t);
}
if (serverByKind.size === 0) {
  console.log(
    "  (no rows carry timings yet — they start with the deploy that added them)",
  );
}
for (const [kind, rows] of [...serverByKind].sort(
  (a, b) => b[1].length - a[1].length,
)) {
  const med = (key) =>
    q(
      rows.map((r) => r[key] ?? 0).filter((v) => v > 0),
      0.5,
    );
  console.log(
    `${kind.padEnd(24)} ${String(rows.length).padStart(3)}  ${fmt(med("total_ms"), "")}  ${fmt(med("context_ms"), "")}  ${fmt(med("calendly_availability_ms"), "")}  ${fmt(med("calendly_config_ms"), "")}  ${fmt(med("calendly_booking_ms"), "")}`,
  );
}

const copySources = new Map();
for (const e of toolEvents) {
  const source = e.payload?.source;
  if (source) copySources.set(source, (copySources.get(source) ?? 0) + 1);
}
if (copySources.size) {
  console.log(
    `\nAvailability answered from: ${[...copySources].map(([k, v]) => `${k}=${v}`).join(", ")}`,
  );
}
console.log();
