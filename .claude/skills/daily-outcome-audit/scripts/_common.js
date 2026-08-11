// Shared helpers for the daily-outcome-audit scripts.
// Reads prod via PostgREST + SUPABASE_SERVICE_ROLE_KEY from the repo's .env.local
// (the Supabase MCP can't reach this project). All windows are Eastern days.
const fs = require("fs");
const path = require("path");

/** Walk up from this file until we find .env.local (repo root). */
function findEnv() {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const p = path.join(dir, ".env.local");
    if (fs.existsSync(p)) return p;
    dir = path.dirname(dir);
  }
  throw new Error(".env.local not found walking up from " + __dirname);
}

const env = fs.readFileSync(findEnv(), "utf8");
const envVar = (k) => {
  const m = env.match(new RegExp("^" + k + "=(.*)$", "m"));
  return m ? m[1].replace(/^["']|["'\r]+$/g, "").trim() : "";
};

const BASE = envVar("NEXT_PUBLIC_SUPABASE_URL") || envVar("SUPABASE_URL");
const SRK = envVar("SUPABASE_SERVICE_ROLE_KEY");
const EL_KEY = envVar("ELEVENLABS_API_KEY");
const H = { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json" };
const TZ = "America/New_York";

/** Whole-hour offset string ("-04:00"/"-05:00") for America/New_York on a date. */
function nyOffset(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    timeZoneName: "shortOffset",
  })
    .formatToParts(d)
    .find((p) => p.type === "timeZoneName").value; // "GMT-4"
  const m = name.match(/GMT([+-]?\d+)/);
  const h = m ? parseInt(m[1], 10) : -5;
  const sign = h < 0 ? "-" : "+";
  return `${sign}${String(Math.abs(h)).padStart(2, "0")}:00`;
}

const addDays = (dateStr, n) => {
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

/** The Eastern calendar date `n` days ago (0 = today ET). */
function etDate(n = 0) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
  return addDays(today, -n);
}

/** UTC [start,end) instants bounding one Eastern day (DST-correct). Defaults to
 *  yesterday. Pass "YYYY-MM-DD" for a specific ET day. */
function etWindow(dateStr) {
  const date = dateStr || etDate(1);
  const next = addDays(date, 1);
  const start = new Date(`${date}T00:00:00${nyOffset(date)}`).toISOString();
  const end = new Date(`${next}T00:00:00${nyOffset(next)}`).toISOString();
  return { date, start, end };
}

const rest = (p) => `${BASE}/rest/v1/${p}`;
const get = async (p) => (await fetch(rest(p), { headers: H })).json();

/** Paginate past PostgREST's 1000-row cap. */
async function pageAll(p) {
  let all = [], from = 0;
  for (;;) {
    const r = await fetch(rest(p), { headers: { ...H, Range: `${from}-${from + 999}` } });
    const b = await r.json();
    if (!Array.isArray(b) || b.length === 0) break;
    all = all.concat(b);
    if (b.length < 1000) break;
    from += 1000;
  }
  return all;
}

const patch = (p, body) =>
  fetch(rest(p), { method: "PATCH", headers: { ...H, Prefer: "return=minimal" }, body: JSON.stringify(body) });
const post = (p, body, rep = false) =>
  fetch(rest(p), { method: "POST", headers: { ...H, Prefer: rep ? "return=representation" : "return=minimal" }, body: JSON.stringify(body) });
const del = (p) => fetch(rest(p), { method: "DELETE", headers: H });
const inList = (ids) => ids.map((x) => `"${x}"`).join(",");

/** ElevenLabs GET (conversations, agents, subscription). */
const elGet = async (urlPath) =>
  (await fetch(`https://api.elevenlabs.io/v1/${urlPath}`, { headers: { "xi-api-key": EL_KEY } })).json();

module.exports = {
  BASE, SRK, EL_KEY, H, TZ, envVar,
  etDate, etWindow, addDays,
  get, pageAll, patch, post, del, inList, rest, elGet,
};
