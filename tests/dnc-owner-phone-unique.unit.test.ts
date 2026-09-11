import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards for the two halves of per-person do-not-call.
 *
 * 20260905241000 moved dnc_entries from `unique (phone)` to
 * `unique (owner_id, phone)` so two users can each list the same number. The
 * constraint could only move once EVERY writer conflicted on
 * (owner_id, phone): Postgres refuses `ON CONFLICT (phone)` the moment no
 * unique index on exactly (phone) exists, and the post-call webhook never
 * checked that error — AI-detected DNC numbers would have silently stopped
 * being written. So this pins both halves: the migration's shape, and that
 * no `onConflict: "phone"` survives anywhere in src.
 *
 * 20260906020000 then made ENFORCEMENT per person too. The product owner
 * asked for it with the consequence spelled out and accepted: a business that
 * tells one teammate to stop can still be called by a different teammate.
 * Enforcement is spread across five places (a SQL view, a SQL function, a SQL
 * helper and two TypeScript reads) and one of them silently reverting to
 * "match on phone alone" is invisible until someone's lead stops dialing — so
 * every one of them is pinned below. The 20260905241000 block used to assert
 * the OPPOSITE ("does not touch dial-time enforcement"); that was right for
 * that migration and is superseded here, not deleted, so the reversal is
 * legible in the diff.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MIGRATION =
  "supabase/migrations/20260905241000_dnc_unique_owner_phone.sql";
const ENFORCEMENT =
  "supabase/migrations/20260906020000_dnc_enforced_per_person.sql";

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

/** Drop `-- ...` comments so prose about the old behaviour never matches. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** The most recent migration that (re)defines `needle`, comments stripped.
 *  Checking the LATEST definition (not just 20260906020000) is the point:
 *  `create or replace` rewrites the whole object, so a future migration
 *  rebuilt from a pre-20260906 copy would silently restore workspace-wide
 *  enforcement. That is exactly how seven dialer rules were lost in July. */
function latestDefining(needle: string): string {
  const dir = join(ROOT, "supabase/migrations");
  const hit = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .reverse()
    .find((f) => readFileSync(join(dir, f), "utf8").includes(needle));
  if (!hit) throw new Error(`no migration defines ${needle}`);
  return stripComments(readFileSync(join(dir, hit), "utf8"));
}

/** Memoised: this walks and reads every .ts/.tsx file under src, including
 *  the ~3,000-line generated database.types.ts. It used to be called once per
 *  test case as well as at collection, so the whole tree was scanned four
 *  times and the file intermittently blew vitest's 5s per-test timeout. The
 *  source cannot change mid-run, so compute it once. */
let dncStatementsCache: { file: string; stmt: string }[] | null = null;

/** Each `from("dnc_entries") … ;` statement in `src`, with its file path.
 *  `[^;]*?` keeps every match inside one statement. */
function dncStatements(): { file: string; stmt: string }[] {
  if (dncStatementsCache) return dncStatementsCache;
  const out: { file: string; stmt: string }[] = [];
  for (const file of walk(join(ROOT, "src"))) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/from\("dnc_entries"\)[^;]*?;/g)) {
      out.push({
        file: file.slice(ROOT.length).replace(/\\/g, "/"),
        stmt: m[0],
      });
    }
  }
  dncStatementsCache = out;
  return out;
}

describe("20260905241000 — dnc_entries unique per (owner_id, phone)", () => {
  const sql = stripComments(read(MIGRATION));

  it("drops the unique-on-phone constraint (by name and by shape)", () => {
    // The DO block finds any unique constraint whose only column is phone …
    expect(sql).toMatch(/con\.contype = 'u'/);
    expect(sql).toMatch(/attname = 'phone'/);
    expect(sql).toMatch(/drop constraint %I/);
  });

  it("adds unique (owner_id, phone)", () => {
    expect(sql).toMatch(
      /add constraint dnc_entries_owner_phone_key unique \(owner_id, phone\)/,
    );
  });

  it("keeps a plain index on phone for the dial-time lookups", () => {
    expect(sql).toMatch(
      /create index if not exists dnc_entries_phone_idx\s+on public\.dnc_entries \(phone\)/,
    );
  });

  it("did not itself touch dial-time enforcement — 20260906020000 does that", () => {
    expect(sql).not.toMatch(/dial_queue|pre_call_check|is_phone_on_dnc/);
  });
});

describe("20260906020000 — enforcement is owner-scoped everywhere", () => {
  it("dial_queue's anti-join matches the LEAD OWNER, not the phone alone", () => {
    const view = latestDefining("create or replace view public.dial_queue");
    expect(view).toMatch(
      /not exists \(\s*select 1 from public\.dnc_entries d\s+where d\.phone = l\.business_phone\s+and d\.owner_id = l\.owner_id\s*\)/,
    );
  });

  it("pre_call_check checks the lead owner's list", () => {
    const fn = latestDefining(
      "create or replace function public.pre_call_check(",
    );
    expect(fn).toMatch(
      /select 1 from public\.dnc_entries\s+where phone = v_lead\.business_phone\s+and owner_id = v_lead\.owner_id/,
    );
  });

  it("pre_call_check also refuses a lead already parked in the 'dnc' stage", () => {
    // RLS lets nobody write a dnc_entries row owned by someone else, so an
    // admin marking a member's lead DNC lands the row on the ADMIN's list.
    // The stage is then the only thing that stops the dial.
    const fn = latestDefining(
      "create or replace function public.pre_call_check(",
    );
    expect(fn).toMatch(
      /if v_lead\.status = 'dnc' then\s+return 'lead_on_dnc';/,
    );
  });

  it("is_phone_on_dnc takes the owner and matches on it", () => {
    const fn = latestDefining(
      "create or replace function public.is_phone_on_dnc(",
    );
    expect(fn).toMatch(
      /function public\.is_phone_on_dnc\(\s*phone_to_check text,\s*owner_to_check uuid\s*\)/,
    );
    expect(fn).toMatch(
      /select 1 from public\.dnc_entries\s+where phone = phone_to_check\s+and owner_id = owner_to_check/,
    );
  });

  it("drops the workspace-wide 1-arg is_phone_on_dnc rather than leaving it", () => {
    const sql = stripComments(read(ENFORCEMENT));
    expect(sql).toMatch(
      /drop function if exists public\.is_phone_on_dnc\(text\);/,
    );
  });

  it("re-grants the new signature to authenticated only", () => {
    // A changed signature is a NEW function, and since 20260905170000 new
    // functions carry no grants at all — call-now.ts runs on the cookie
    // client, so it would 403 without this.
    const sql = stripComments(read(ENFORCEMENT));
    expect(sql).toMatch(
      /grant execute on function public\.is_phone_on_dnc\(text, uuid\) to authenticated;/,
    );
    expect(sql).not.toMatch(/grant execute[^;]*to[^;]*\banon\b/);
  });
});

/* There is no carve-out list any more. src/lib/dnc/actions.ts held the one
 * exemption: removeFromDnc looked a number up by phone on the cookie client
 * and leaned on the SELECT policy meaning "owner_id = auth.uid()" to make
 * a miss mean "not on YOUR list". Both halves of that expired -- phone
 * stopped being unique at 20260905241000, and the super admin started
 * seeing every list at 20260906030000, which would have made the lookup
 * match two rows and fail. It addresses the row by id now, so the rule
 * below applies to every call site, with no exceptions. */

describe("every dnc_entries lookup by phone is owner-scoped", () => {
  // A lookup that decides something — can we dial, can we text, is this lead
  // DNC, does this lead belong in the ad audience — must name an owner.
  // Writes name one too (`owner_id:` in the payload), so one rule covers both
  // and a new call site can't quietly reintroduce the workspace-wide match.
  const byPhone = dncStatements().filter((s) => /\.eq\("phone"/.test(s.stmt));

  it.each(byPhone)("$file", ({ stmt }) => {
    expect(stmt).toMatch(/owner_id/);
  });

  it("removes an entry by id, never by a phone that is no longer unique", () => {
    const actions = read("src/lib/dnc/actions.ts");
    expect(actions).toMatch(
      /\.from\("dnc_entries"\)[^;]*\.eq\("id", input\.id\)/,
    );
    expect(actions).not.toMatch(/\.from\("dnc_entries"\)[^;]*\.eq\("phone"/);
  });

  it("covers the lookups we know about", () => {
    // A regex that stops matching (a refactor, a renamed table) would make
    // the it.each above vacuously pass with zero cases.
    expect(byPhone.map((s) => s.file)).toEqual(
      expect.arrayContaining([
        "src/lib/elevenlabs/tool-webhook.ts",
        "src/lib/leads/recompute-call-state.ts",
      ]),
    );
  });

  // The two service-role lookups that read the WHOLE list rather than one
  // phone: the Meta audience sync and its manual CSV twin. Each user's leads
  // go into that user's own audience, so a teammate's suppression is not
  // theirs to apply — and RLS is not filtering, the service key is in use.
  it.each([
    "src/lib/meta/sync.ts",
    "src/app/(app)/settings/integrations/meta/export/route.ts",
  ])("%s scopes its whole-list read to one owner", (rel) => {
    const stmts = dncStatements().filter((s) => s.file === rel);
    expect(stmts, rel).not.toHaveLength(0);
    for (const { stmt } of stmts) {
      expect(stmt, rel).toMatch(/\.eq\("owner_id",/);
    }
  });
});

describe("both is_phone_on_dnc callers pass the lead owner and fail closed", () => {
  it.each([
    "src/lib/dialer/call-now.ts",
    "src/app/api/twilio/voice-browser-dial/route.ts",
  ])("%s", (rel) => {
    const src = read(rel);
    const call = /rpc\(\s*"is_phone_on_dnc",[\s\S]*?\);/.exec(src);
    expect(call, rel).not.toBeNull();
    // The lead's owner, never the signed-in user: an admin dialling a
    // member's lead must honour the member's list.
    expect(call![0]).toMatch(/owner_to_check:\s*lead\.owner_id/);
    // An RPC error must refuse the dial. It used to be dropped on the floor,
    // so a missing grant or a moved signature read as "not on DNC".
    expect(src.slice(call!.index)).toMatch(/(dncError|dnc\.error)/);
  });
});

describe("the booking phone's DNC read fails closed", () => {
  it("bookAppointment reads the lookup's error and turns it into 'unknown', never 'clear'", () => {
    const src = read("src/lib/elevenlabs/tool-webhook.ts");
    // A dropped error reads as "not on DNC" (see the is_phone_on_dnc callers
    // above); bookingPhoneOutcome treats "unknown" as not clear.
    const lookup =
      /error:\s*(\w+)\s*\}\s*=\s*await ctx\.supabase\s*\.from\("dnc_entries"\)[^;]*\.eq\("phone",\s*bookingPhone\.phone\)/.exec(
        src,
      );
    expect(lookup, "bookAppointment dnc_entries lookup").not.toBeNull();
    // Build the second pattern from the SAME variable the destructuring above
    // just captured, so a mapping keyed on a different variable (e.g.
    // `dncLookup = dncHits ? "unknown" : …`, checking the row count instead of
    // the error) fails this check instead of slipping past a bare `\w+`.
    const errVar = lookup![1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(src).toMatch(
      new RegExp(`dncLookup\\s*=\\s*${errVar}\\s*\\?\\s*"unknown"`),
    );
  });
});

describe("createInvitee only ever receives the DNC-filtered optional answer", () => {
  it("optionalQuestionsAndAnswers is built from phoneOutcome.optionalAnswer, never the raw buildOptionalPhoneAnswer result", () => {
    const src = read("src/lib/elevenlabs/tool-webhook.ts");
    // If this were built from buildOptionalPhoneAnswer(...) directly, a
    // do-not-call number would reach createInvitee unfiltered — the whole
    // point of bookingPhoneOutcome is to sit between the two.
    expect(src).toMatch(
      /optionalQuestionsAndAnswers:\s*phoneOutcome\.optionalAnswer\s*\?\s*\[phoneOutcome\.optionalAnswer\]/,
    );
  });
});

describe("a failed mobile_phone save is logged, not swallowed", () => {
  it("captures the update's error and flags mobile_save_failed on both outcome audits, keyed on that same error", () => {
    const src = read("src/lib/elevenlabs/tool-webhook.ts");
    const save =
      /error:\s*(\w+)\s*\}\s*=\s*await ctx\.supabase\s*\.from\("leads"\)[^;]*\.update\(\{\s*mobile_phone:[^;]*;/.exec(
        src,
      );
    expect(save, "leads.mobile_phone save").not.toBeNull();
    const errVar = save![1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // The flag must be set FROM that same captured error …
    const flagSet = new RegExp(
      `if\\s*\\(${errVar}\\)\\s*(\\w+)\\s*=\\s*true;`,
    ).exec(src);
    expect(flagSet, "mobile_save_failed flag assignment").not.toBeNull();
    const flagVar = flagSet![1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const usesFlag = new RegExp(
      `${flagVar}\\s*\\?\\s*\\{\\s*mobile_save_failed:\\s*true\\s*\\}`,
    );
    // … and BOTH the failure and success tool_book_appointment audits must
    // use it, not just one of them.
    const failure =
      /logToolEvent\(ctx, "tool_book_appointment", \{[^;]*?error: result\.error[^;]*?\}\);/.exec(
        src,
      );
    const success =
      /logToolEvent\(ctx, "tool_book_appointment", \{[^;]*?invitee_uri: result\.inviteeUri[^;]*?\}\);/.exec(
        src,
      );
    expect(failure, "tool_book_appointment failure audit").not.toBeNull();
    expect(success, "tool_book_appointment success audit").not.toBeNull();
    expect(failure![0], "failure audit").toMatch(usesFlag);
    expect(success![0], "success audit").toMatch(usesFlag);
  });
});

describe("every dnc_entries writer conflicts on (owner_id, phone)", () => {
  const files = walk(join(ROOT, "src"));

  it('no dnc_entries write still conflicts on "phone" alone', () => {
    // Scoped to dnc_entries statements: other tables (phone_line_types, the
    // Twilio-lookup cache) legitimately key on `phone` by itself, and `[^;]*`
    // keeps the match inside a single statement.
    const offenders = files.filter((f) =>
      /from\("dnc_entries"\)[^;]*onConflict:\s*["']phone["']/.test(
        readFileSync(f, "utf8"),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("the known writers upsert on owner_id,phone and stamp owner_id", () => {
    const writers = [
      "src/lib/elevenlabs/post-call-webhook.ts",
      "src/lib/elevenlabs/tool-webhook.ts",
      "src/app/api/close/webhook/route.ts",
      "src/lib/dnc/actions.ts",
      "src/lib/dnc/import-actions.ts",
      "src/lib/leads/inline-actions.ts",
    ];
    for (const rel of writers) {
      const src = read(rel);
      expect(src, rel).toMatch(/onConflict:\s*"owner_id,phone"/);
      expect(src, rel).toMatch(/owner_id:/);
    }
  });

  it("dial-time / send-time DNC reads never use maybeSingle() on phone (two owners can hold one number)", () => {
    for (const rel of [
      "src/lib/elevenlabs/tool-webhook.ts",
      "src/lib/leads/recompute-call-state.ts",
    ]) {
      const src = read(rel);
      // `[^;]*?` keeps each match inside one statement — across statements it
      // would run from the dnc_entries upsert into the next unrelated
      // maybeSingle() in the file and fail on code that is fine.
      const reads = src.match(
        /from\("dnc_entries"\)[^;]*?\.(maybeSingle|limit)\(/g,
      );
      expect(reads, rel).not.toBeNull();
      for (const r of reads ?? []) {
        expect(r, rel).not.toMatch(/maybeSingle\(/);
      }
    }
  });
});
