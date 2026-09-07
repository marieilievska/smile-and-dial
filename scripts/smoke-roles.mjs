// Render every app route as each real account, and report what came back.
//
//   node --env-file=.env.local scripts/smoke-roles.mjs [--role=member] [--base=…]
//   (or: npm run smoke:roles)
//
// The September frontend audit reviewed all three roles in code but could only
// drive the live app as ONE of them — `marie@` (admin) — because the browser was
// already signed in as that account and signing in as another needs a password.
// That left the two views nobody had ever loaded: `member`, which owns nothing,
// and `super_admin`, which sees everything but owns nothing either.
//
// So this signs in without a password, the only way that does not involve one:
// auth.admin.generateLink() mints a magic-link token for an account that already
// exists, and verifyOtp() exchanges it for a session. No password is read,
// entered or stored; no account is created; nothing is written. generateLink
// does NOT send mail (unlike inviteUserByEmail) — it returns the token.
//
// The session lives in this process only. It never touches the browser, so
// whoever is signed in there stays signed in.
//
// Then two layers, because they fail differently:
//
//   RLS      the same reads the pages make, run with that user's JWT through
//            the anon key. Proves what the DATABASE will hand this role.
//   Pages    a real GET of each route with that session's cookies. Proves what
//            the app DOES with it — an empty state, an error boundary, or a
//            redirect to /login.
//
// Every route below is a GET that renders a page; no page.tsx or layout.tsx in
// this app writes during render (welcome_seen_at is stamped by a client action
// on dismissal, never by rendering), so this is READ ONLY.

import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !anonKey || !serviceKey) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY.",
  );
  process.exit(1);
}

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const BASE = arg("base", "https://www.smile-and-dial.com").replace(/\/$/, "");
const ONLY_ROLE = arg("role", null);

const admin = createClient(url, serviceKey);

/** Every route that renders a page. Query strings included where a tab is a
 *  distinct surface with its own data path. Dynamic segments are resolved per
 *  role further down, because a member may have no row to point at. */
const ROUTES = [
  "/today",
  "/leads",
  "/leads/import",
  "/calls",
  "/callbacks",
  "/campaigns",
  "/analytics",
  "/reporting",
  "/reporting?tab=cohorts",
  "/reporting?tab=cause-of-death",
  "/reporting?tab=numbers",
  "/reporting?tab=changelog",
  "/reporting?tab=prompt-log",
  "/costs",
  "/goals",
  "/dnc",
  "/dnc/import",
  "/archived",
  "/settings",
  "/settings/overview",
  "/settings/agents",
  "/settings/agents/new",
  "/settings/agents/new/scratch",
  "/settings/agents/templates/new",
  "/settings/api",
  "/settings/custom-fields",
  "/settings/email-templates",
  "/settings/goals",
  "/settings/integrations",
  "/settings/knowledge-bases",
  "/settings/lists",
  "/settings/sms-templates",
  "/settings/twilio-numbers",
  "/settings/users",
];

// --- signing in, without a password ----------------------------------------

/** A real session for an existing account. Returns the session plus the exact
 *  cookies @supabase/ssr would have written, produced BY @supabase/ssr rather
 *  than hand-rolled, so the format cannot drift from what the app parses. */
async function sessionFor(email) {
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkErr) throw new Error(`generateLink(${email}): ${linkErr.message}`);
  const tokenHash = link?.properties?.hashed_token;
  if (!tokenHash) throw new Error(`no hashed_token for ${email}`);

  const plain = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: verified, error: otpErr } = await plain.auth.verifyOtp({
    token_hash: tokenHash,
    type: "magiclink",
  });
  if (otpErr) throw new Error(`verifyOtp(${email}): ${otpErr.message}`);
  const session = verified.session;
  if (!session) throw new Error(`no session for ${email}`);

  // Let the library serialise the cookies, chunking and encoding included.
  const jar = new Map();
  const ssr = createServerClient(url, anonKey, {
    cookies: {
      getAll: () =>
        [...jar.entries()].map(([name, value]) => ({ name, value })),
      setAll: (list) => list.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
  await ssr.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });

  const cookie = [...jar.entries()]
    .map(([n, v]) => `${n}=${encodeURIComponent(v)}`)
    .join("; ");
  return { session, cookie, userId: session.user.id };
}

/** A Supabase client that reads as this user — anon key, their JWT, RLS on. */
function clientAs(accessToken) {
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// --- the two layers ---------------------------------------------------------

const dash = (v) => (v === null || v === undefined ? "—" : String(v));

async function rlsChecks(sb, userId) {
  const rows = [];
  const count = async (table, q) => {
    let query = sb.from(table).select("id", { count: "exact", head: true });
    if (q) query = q(query);
    const { count: n, error } = await query;
    return error
      ? `ERR ${error.code ?? ""} ${error.message}`.trim().slice(0, 90)
      : n;
  };

  rows.push(["leads visible", await count("leads")]);
  rows.push(["calls visible", await count("calls")]);
  rows.push(["campaigns visible", await count("campaigns")]);
  rows.push(["lists visible", await count("lists")]);
  rows.push(["agents visible", await count("agents")]);
  rows.push(["twilio numbers visible", await count("twilio_numbers")]);
  rows.push(["profiles visible", await count("profiles")]);
  rows.push([
    "leads owned by me",
    await count("leads", (q) => q.eq("owner_id", userId)),
  ]);

  // The five aggregates from the September rewrites: EXECUTE was granted to
  // `authenticated`, and each is SECURITY INVOKER, so a member must be able to
  // call them and get their own scope back rather than an error.
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const rpc = async (name, args) => {
    const { data, error } = await sb.rpc(name, args);
    if (error) return `ERR ${error.code ?? ""} ${error.message}`.slice(0, 90);
    return data;
  };

  const analytics = await rpc("analytics_summary", {
    p_start: since,
    p_end: new Date().toISOString(),
  });
  rows.push([
    "analytics_summary",
    typeof analytics === "string"
      ? analytics
      : `${dash(analytics?.totals?.total_calls)} calls`,
  ]);

  const daily = await rpc("reporting_daily_kpis", { p_since: since });
  rows.push([
    "reporting_daily_kpis",
    typeof daily === "string" ? daily : `${(daily ?? []).length} days`,
  ]);

  const cod = await rpc("cause_of_death_summary", {
    p_since: since,
    p_sample: 5,
  });
  rows.push([
    "cause_of_death_summary",
    typeof cod === "string" ? cod : `${dash(cod?.total)} worked leads`,
  ]);

  const nums = await rpc("number_performance_summary", { p_since: since });
  rows.push([
    "number_performance_summary",
    typeof nums === "string"
      ? nums
      : `${Object.keys(nums?.byNumber ?? {}).length} numbers`,
  ]);

  return rows;
}

/** What the app did with the request. */
function verdictOf(status, finalUrl, html) {
  if (finalUrl.includes("/login")) return ["LOGIN", "redirected to /login"];
  if (status === 404) return ["404", "not found"];
  if (status >= 500) return ["5xx", `HTTP ${status}`];
  if (status !== 200) return [String(status), `HTTP ${status}`];
  if (/Couldn&#x27;t load|Couldn't load|Something went wrong/.test(html))
    return ["ERROR", "error boundary rendered"];
  if (/This page could not be found/.test(html)) return ["404", "next 404"];
  return ["ok", ""];
}

async function pageChecks(cookie) {
  const out = [];
  for (const route of ROUTES) {
    const t0 = Date.now();
    let status = 0;
    let finalUrl = "";
    let html = "";
    try {
      const res = await fetch(BASE + route, {
        headers: { cookie, "user-agent": "smoke-roles/1.0" },
        redirect: "follow",
      });
      status = res.status;
      finalUrl = res.url;
      html = await res.text();
    } catch (e) {
      out.push({
        route,
        verdict: "FETCH",
        note: String(e).slice(0, 60),
        ms: 0,
      });
      continue;
    }
    const [verdict, note] = verdictOf(status, finalUrl, html);
    out.push({
      route,
      verdict,
      note,
      ms: Date.now() - t0,
      kb: Math.round(html.length / 1024),
    });
  }
  return out;
}

// --- run --------------------------------------------------------------------

const { data: profiles, error: pErr } = await admin
  .from("profiles")
  .select("id, email, role, active")
  .order("role");
if (pErr) {
  console.error(`profiles: ${pErr.message}`);
  process.exit(1);
}

const targets = profiles.filter(
  (p) => p.active && (ONLY_ROLE ? p.role === ONLY_ROLE : true),
);
if (targets.length === 0) {
  console.error(`No active profile matches --role=${ONLY_ROLE}.`);
  process.exit(1);
}

let problems = 0;
console.log(`Smoke test against ${BASE}\n`);

for (const p of targets) {
  const masked = p.email.replace(/^(.{2}).*@/, "$1***@");
  console.log(`${"=".repeat(72)}\n${p.role}  (${masked})\n`);

  let auth;
  try {
    auth = await sessionFor(p.email);
  } catch (e) {
    problems++;
    console.log(`  could not establish a session: ${e.message}\n`);
    continue;
  }

  console.log("  RLS — what the database hands this role");
  for (const [label, value] of await rlsChecks(
    clientAs(auth.session.access_token),
    auth.userId,
  )) {
    const bad = typeof value === "string" && value.startsWith("ERR");
    if (bad) problems++;
    console.log(`    ${bad ? "!!" : "  "} ${label.padEnd(28)} ${dash(value)}`);
  }

  console.log("\n  Pages — what the app renders");
  const pages = await pageChecks(auth.cookie);
  for (const r of pages) {
    if (r.verdict !== "ok") problems++;
    const flag = r.verdict === "ok" ? "  " : "!!";
    console.log(
      `    ${flag} ${r.route.padEnd(38)} ${String(r.ms).padStart(5)}ms ` +
        `${String(r.kb ?? "").padStart(4)}KB  ${r.verdict}${r.note ? ` — ${r.note}` : ""}`,
    );
  }
  const slowest = [...pages].sort((a, b) => b.ms - a.ms)[0];
  console.log(
    `\n  ${pages.filter((r) => r.verdict === "ok").length}/${pages.length} routes rendered; ` +
      `slowest ${slowest.route} at ${slowest.ms}ms\n`,
  );
}

console.log("=".repeat(72));
if (problems === 0) {
  console.log("No problems found.");
  process.exit(0);
}
console.log(`${problems} thing(s) to look at above.`);
process.exit(1);
